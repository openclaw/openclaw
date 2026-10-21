import { expect, test, vi } from "vitest";
import { expandSessionRowFacts } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as visibility from "../shared/session-list-visibility.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import type { GatewayClient } from "./server-methods/types.js";
import { profileActor, writeListEntry } from "./session-list-entry.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

function viewer(name: string): GatewayClient {
  const profileId = ensureProfileForEmail(`${name}@example.com`).id;
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: { profileId, displayName: profileId, hasAvatar: false, updatedAt: 1 },
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
  };
}

function initialize(
  cfg: Parameters<typeof setRuntimeConfigSnapshot>[0] = { agents: { entries: { main: {} } } },
) {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot(cfg);
  return cfg;
}

function viewerPage(ids: string, order: string, activityOrder: string, roles: string) {
  const orderedIds = order.split(" ");
  return {
    ids: ids.split(" "),
    order: orderedIds,
    activityOrder: activityOrder.split(" "),
    roles: roles.split(" "),
    total: orderedIds.length,
  };
}

function expectPage(
  result: Awaited<ReturnType<typeof listProjectedSessions>>,
  ids: string[],
  total: number,
) {
  expect([sessionIds(result), result.totalCount]).toEqual([ids, total]);
}

function sessionIds(result: Awaited<ReturnType<typeof listProjectedSessions>>) {
  return result.sessions.map((row) => row.sessionId);
}

function patchEntry(
  store: Record<string, SessionEntry>,
  key: string,
  patch: Partial<SessionEntry>,
) {
  writeListEntry(key, { ...store[key]!, ...patch });
}

test("preserves viewer pages across publications while bounding shared predicate work", async () => {
  await withStateDirEnv("openclaw-list-viewer-golden-", async () => {
    const cfg = initialize({
      agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
    });
    const clients = ["alice", "bob", "admin"].map(viewer);
    clients[2]!.connect.scopes = ["operator.admin"];
    const entry = (sessionId: string, owner: number, updatedAt: number): SessionEntry => ({
      sessionId,
      updatedAt,
      lastInteractionAt: 20 - updatedAt,
      createdActor: profileActor(clients[owner]!.authenticatedUserProfile!.profileId),
    });
    const store = {
      "agent:main:a": {
        ...entry("a", 0, 1),
        heartbeatIsolatedBaseSessionKey: "agent:main:heartbeat",
        label: "Operator lane",
      },
      "agent:main:b": { ...entry("b", 0, 9), visibility: "draft" as const },
      "agent:main:c": entry("c", 1, 8),
      "agent:main:d": { ...entry("d", 1, 10), archivedAt: 1 },
      "agent:main:f": entry("f", 2, 7),
    };
    writeResidentEntries(store);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    using predicate = vi.spyOn(visibility, "isSystemCreatedSessionRow");
    using selectEntries = vi.spyOn(projection, "selectEntries");
    const opts = { limit: 2, ownerFirst: true, excludeSystem: true };
    const read = (
      client: GatewayClient | undefined,
      overrides: Parameters<typeof listProjectedSessions>[0]["opts"] = {},
    ) => listProjectedSessions({ projection, client, opts: { ...opts, ...overrides } });
    const golden = [
      [
        viewerPage("b a c", "b c f a", "a f c b", "owner owner viewer"),
        viewerPage("c f", "c f a", "a f c", "owner viewer"),
        viewerPage("f b c", "b c f a", "a f c b", "admin admin admin"),
      ],
      [
        viewerPage("b d", "d b", "b d", "owner viewer"),
        viewerPage("d b", "d b", "b d", "owner viewer"),
        viewerPage("f d", "f d b", "b d f", "admin admin"),
      ],
    ];
    try {
      await projection.ensureMaterialized();
      // Establish active display demand without priming list selection or cold archives.
      for (const row of projection.selectEntries()) {
        if (row.entry?.archivedAt === undefined) {
          projection.describe(row);
        }
      }
      for (let revision = 0; revision < 2; revision++) {
        await projection.ensureMaterialized();
        await read(clients[0]);
        predicate.mockClear();
        selectEntries.mockClear();
        for (const [index, client] of clients.entries()) {
          const expected = golden[revision]![index]!;
          using projectOwner = vi.spyOn(projection.state.rowContext.identityProjection!, "owner");
          const result = await read(client);
          expect(projectOwner.mock.calls.length).toBeLessThanOrEqual(expected.total);
          expectPage(result, expected.ids, expected.total);
          expect(result).toMatchObject({
            count: expected.ids.length,
            hasMore: expected.total > 2,
            nextOffset: expected.total > 2 ? 2 : null,
          });
          expect(result.sessions.map((row) => row.sharingRole)).toEqual(expected.roles);
          for (const [limit, offset] of [
            [1, 1],
            [2, 1],
            [1, 2],
          ] as const) {
            const next = await read(client, { limit, offset });
            expectPage(next, expected.order.slice(offset, offset + limit), expected.total);
          }
          const activity = await read(client, {
            ownerFirst: false,
            sortBy: "activity",
            includeActivitySummary: false,
          });
          expectPage(activity, expected.activityOrder.slice(0, opts.limit), expected.total);
          const people = await read(client, {
            ownerFirst: false,
            sortBy: "updatedAt",
            includePeople: true,
          });
          expect(sessionIds(people)).toEqual(expected.order.slice(0, opts.limit));
          expect(people.peopleSessionCount).toBe(expected.total);
          expect(people.people?.reduce((count, person) => count + person.sessionCount, 0)).toBe(
            expected.total,
          );
        }
        expect(
          sessionIds(await read(clients[0], { ownerFirst: false, search: "agent:main:b" })),
        ).toEqual(["b"]);
        {
          using clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
          const recent = () => read(clients[0], { activeMinutes: 1 });
          expect((await recent()).totalCount).toBe(golden[revision]![0]!.total);
          clock.mockReturnValue(120_000);
          expect((await recent()).sessions).toEqual([]);
        }
        expect(selectEntries.mock.calls.length).toBe(0);
        expect(predicate).not.toHaveBeenCalled();
        // Removing a heartbeat's operator label changes its accepted classification.
        const archivedIds = revision === 0 ? ["d"] : [];
        const readArchive = () => read(clients[0], { ownerFirst: false, archived: true });
        expectPage(await readArchive(), archivedIds, archivedIds.length);
        // Cold archives can acquire metadata; warm reads and filter changes reuse those facts.
        predicate.mockClear();
        expect(sessionIds(await readArchive())).toEqual(archivedIds);
        expect(predicate).not.toHaveBeenCalled();
        expect(sessionIds(await read(clients[0]))).toEqual(golden[revision]![0]!.ids);
        expect(predicate).not.toHaveBeenCalled();
        if (revision === 0) {
          patchEntry(store, "agent:main:a", { label: undefined, archivedAt: 2 });
          patchEntry(store, "agent:main:b", { visibility: "shared" });
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            archiveTranscript: false,
            target: { canonicalKey: "agent:main:c", storeKeys: ["agent:main:c"] },
          });
          writeListEntry("agent:main:d", entry("d", 1, 11));
          writeListEntry("agent:main:f", { ...entry("f", 2, 12), visibility: "draft" });
        }
      }
    } finally {
      projection.dispose();
      release();
    }
  });
});

test("refreshes cached lists after placement readiness and refuses disposed responses", async () => {
  await withStateDirEnv("openclaw-list-placement-readiness-", async () => {
    const cfg = initialize();
    const alice = viewer("alice");
    const bob = ensureProfileForEmail("bob@placement.example");
    alice.connect.scopes = ["operator.admin"];
    const initialNow = 1_800_000_000_000;
    using clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    const entry = (sessionId: string): SessionEntry => ({
      sessionId,
      updatedAt: sessionId === "aged" ? initialNow : initialNow + 2,
      archivedAt: 1,
      visibility: sessionId === "admin-only" ? "draft" : "shared",
      createdActor: profileActor(bob.id),
    });
    const store = Object.fromEntries(
      ["admin-only", "publication", "aged", "stable"].map((id) => [`agent:main:${id}`, entry(id)]),
    );
    writeResidentEntries(store);
    const empty: WorkerSessionPlacementProjection = {
      placements: new Map(),
      moves: new Map(),
      pendingResults: new Map(),
      workspaceJournalOwnerSessionIds: new Set(),
      environments: new Map(),
      workspaceResultReconcilingSessionIds: new Set(),
      workspaceRecoveryPendingSessionIds: new Set(),
    };
    let entered = createDeferredCore();
    let paused = createDeferredCore<WorkerSessionPlacementProjection>();
    let hold = true;
    const readProjection = vi.fn(async () => {
      if (hold) {
        entered.resolve();
        return paused.promise;
      }
      return empty;
    });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: { readProjection },
    });
    using selected = vi.spyOn(projection, "selectEntries");
    const read = () =>
      listProjectedSessions({
        projection,
        client: alice,
        opts: { archived: true, activeMinutes: 1 },
      });
    let pending: ReturnType<typeof listProjectedSessions> | undefined;
    try {
      // Populate common selection while all rows and their placement facts remain cold.
      expect((await listProjectedSessions({ projection, opts: {} })).sessions).toEqual([]);
      selected.mockClear();
      pending = read();
      await entered.promise;
      alice.connect.scopes = ["operator.read"];
      clock.mockReturnValue(initialNow + 60_001);
      writeListEntry("agent:main:publication", {
        ...entry("publication"),
        updatedAt: Date.now(),
        visibility: "draft",
      });
      hold = false;
      paused.resolve(empty);
      const result = await pending;
      expect(sessionIds(result)).toEqual(["stable"]);
      expect(result.sessions[0]?.sharingRole).toBe("viewer");
      // The publication can leave unselected archives dirty; warm its completed revision.
      await read();
      selected.mockClear();
      readProjection.mockClear();
      expect(sessionIds(await read())).toEqual(["stable"]);
      expect(selected).not.toHaveBeenCalled();
      expect(readProjection).not.toHaveBeenCalled();

      alice.connect.scopes = ["operator.admin"];
      entered = createDeferredCore();
      paused = createDeferredCore<WorkerSessionPlacementProjection>();
      hold = true;
      sessionChanges.emit({ all: true, scope: "worker-placements" });
      const onResult = vi.fn();
      pending = listProjectedSessions({
        projection,
        client: alice,
        opts: { archived: true },
        onResult,
      });
      const rejected = expect(pending).rejects.toThrow("no longer active");
      await entered.promise;
      projection.dispose();
      paused.resolve(empty);
      await rejected;
      expect(onResult).not.toHaveBeenCalled();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      const settled = pending?.catch(() => {});
      hold = false;
      projection.dispose();
      paused.resolve(empty);
      await settled;
      release();
    }
  });
});

test("shares concurrent list selection across row modes and refilters only published partitions", async () => {
  await withStateDirEnv("openclaw-list-selection-repeat-", async () => {
    const cfg = initialize();
    const alice = viewer("alice");
    const bob = viewer("bob");
    const now = 1_800_000_000_000;
    using clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `agent:main:selection-${index}`,
        {
          sessionId: `s${index}`,
          updatedAt: now + index,
          visibility: "shared" as const,
          createdActor: profileActor(
            (index === 127 ? bob : alice).authenticatedUserProfile!.profileId,
          ),
        },
      ]),
    );
    writeResidentEntries(store);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const read = (rowMode: "compact" | "sidebar", client = alice, limit = 2) =>
      listProjectedSessions({
        projection,
        client,
        acceptsSerializedJson: true,
        opts: { limit, activeMinutes: 1, rowMode },
      });
    try {
      expect(sessionIds(await read("compact"))).toEqual(["s127", "s126"]);
      using owner = vi.spyOn(projection.state.rowContext.identityProjection!, "owner");
      const repeated = await Promise.all(
        Array.from({ length: 8 }, (_, i) => read(i % 2 ? "compact" : "sidebar")),
      );
      expect(repeated.map((result) => result.totalCount)).toEqual(Array(8).fill(128));
      expect(owner).not.toHaveBeenCalled();
      for (const client of [alice, bob]) {
        for (const rowMode of ["compact", "sidebar"] as const) {
          await read(rowMode, client, 2);
          await read(rowMode, client, 128);
        }
      }
      using stringify = vi.spyOn(JSON, "stringify");
      using present = vi.spyOn(projection, "present");
      for (const client of [alice, bob, alice, bob]) {
        for (const rowMode of ["compact", "sidebar"] as const) {
          stringify.mockClear();
          await read(rowMode, client, 2);
          const smallPageEncodings = stringify.mock.calls.length;
          stringify.mockClear();
          const result = await read(rowMode, client, 128);
          const encodings = stringify.mock.calls.length;
          expect(result.totalCount).toBe(128);
          // Fixed request preparation may encode facts; additional warm rows must not.
          expect(encodings, `warm ${rowMode} serialization scales with row count`).toBe(
            smallPageEncodings,
          );
          const rows = expandSessionRowFacts(result.sessions, result.sharedFacts);
          expect(rows.every((row) => row.rowMode === rowMode)).toBe(true);
          expect(rows.find((row) => row.sessionId === "s127")?.sharingRole).toBe(
            client === bob ? "owner" : "viewer",
          );
          expect(rows.find((row) => row.sessionId === "s0")?.sharingRole).toBe(
            client === alice ? "owner" : "viewer",
          );
        }
      }
      expect(present).not.toHaveBeenCalled();
      stringify.mockRestore();
      present.mockRestore();
      owner.mockClear();
      patchEntry(store, "agent:main:selection-0", { updatedAt: now + 200, visibility: "draft" });
      expectPage(await read("compact"), ["s0", "s127"], 128);
      expect(owner.mock.calls.length).toBeLessThan(32);
      expectPage(await read("compact", bob), ["s127", "s126"], 127);
      // An exact publication must not hide an expired retained partition.
      clock.mockReturnValue(now + 60_128);
      patchEntry(store, "agent:main:selection-1", { updatedAt: Date.now() });
      expectPage(await read("compact"), ["s1", "s0"], 2);
      setDisplayName(alice.authenticatedUserProfile!.profileId, "Renamed Alice");
      patchEntry(store, "agent:main:selection-127", { updatedAt: Date.now() });
      const renamed = await read("compact");
      expect(renamed.totalCount).toBe(3);
      expect(
        renamed.owners?.find((actor) => actor.id === alice.authenticatedUserProfile!.profileId)
          ?.label,
      ).toBe("Renamed Alice");
    } finally {
      projection.dispose();
      release();
    }
  });
});

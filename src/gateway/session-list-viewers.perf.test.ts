import { expect, test, vi } from "vitest";
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

function viewer(profileId: string): GatewayClient {
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

function initialize(cfg: Parameters<typeof setRuntimeConfigSnapshot>[0]) {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot(cfg);
}

function viewerPage(ids: string, order: string, activityOrder: string, total: number) {
  return {
    ids: ids.split(" "),
    order: order.split(" "),
    activityOrder: activityOrder.split(" "),
    total,
  };
}

function expectPage(
  result: Awaited<ReturnType<typeof listProjectedSessions>>,
  ids: string[],
  total: number,
) {
  expect([result.sessions.map((row) => row.sessionId), result.totalCount]).toEqual([ids, total]);
}

test("preserves viewer pages across publications while bounding shared predicate work", async () => {
  await withStateDirEnv("openclaw-list-viewer-golden-", async () => {
    const cfg = {
      agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
    };
    initialize(cfg);
    const clients = ["alice", "bob", "admin"].map((name) =>
      viewer(ensureProfileForEmail(`${name}@example.com`).id),
    );
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
    const predicate = vi.spyOn(visibility, "isSystemCreatedSessionRow");
    const selectEntries = vi.spyOn(projection, "selectEntries");
    const opts = { limit: 2, ownerFirst: true, excludeSystem: true };
    const read = (
      client: GatewayClient | undefined,
      overrides: Parameters<typeof listProjectedSessions>[0]["opts"] = {},
    ) => listProjectedSessions({ projection, client, opts: { ...opts, ...overrides } });
    const golden = [
      [
        viewerPage("b a c", "b c f a", "a f c b", 4),
        viewerPage("c f", "c f a", "a f c", 3),
        viewerPage("f b c", "b c f a", "a f c b", 4),
      ],
      [
        viewerPage("b d", "d b", "b d", 2),
        viewerPage("d b", "d b", "b d", 2),
        viewerPage("f d", "f d b", "b d f", 3),
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
        // The first viewer primes only viewer-independent membership.
        await read(clients[0]);
        predicate.mockClear();
        selectEntries.mockClear();
        for (const [index, client] of clients.entries()) {
          const expected = golden[revision]![index]!;
          using projectOwner = vi.spyOn(projection.state.rowContext.identityProjection!, "owner");
          const result = await read(client);
          expect(projectOwner.mock.calls.length).toBeLessThanOrEqual(expected.total);
          expectPage(result, expected.ids, expected.total);
          expect(result.count).toBe(expected.ids.length);
          expect(result.hasMore).toBe(expected.total > 2);
          expect(result.nextOffset).toBe(expected.total > 2 ? 2 : null);
          expect(result.sessions.map((row) => row.sharingRole)).toEqual(
            expected.ids.map((id) =>
              client === clients[2]
                ? "admin"
                : (client === clients[0] ? ["a", "b"] : ["c", "d"]).includes(id)
                  ? "owner"
                  : "viewer",
            ),
          );
          for (const page of [
            { limit: 1, offset: 1 },
            { limit: 2, offset: 1 },
            { limit: 1, offset: 2 },
          ]) {
            const next = await read(client, page);
            expectPage(
              next,
              expected.order.slice(page.offset, page.offset + page.limit),
              expected.total,
            );
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
          expect(people.sessions.map((row) => row.sessionId)).toEqual(
            expected.order.slice(0, opts.limit),
          );
          expect(people.peopleSessionCount).toBe(expected.total);
          expect(people.people?.reduce((count, person) => count + person.sessionCount, 0)).toBe(
            expected.total,
          );
        }
        expect.soft(predicate.mock.calls.length).toBe(0);
        expect.soft(selectEntries.mock.calls.length).toBe(0);
        const searched = await read(clients[0], { ownerFirst: false, search: "agent:main:b" });
        expect(searched.sessions.map((row) => row.sessionId)).toEqual(["b"]);
        const clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
        try {
          const recent = () => read(clients[0], { activeMinutes: 1 });
          expect((await recent()).totalCount).toBe(golden[revision]![0]!.total);
          clock.mockReturnValue(120_000);
          expect((await recent()).sessions).toEqual([]);
        } finally {
          clock.mockRestore();
        }
        expect(selectEntries.mock.calls.length).toBe(0);
        expect(predicate).not.toHaveBeenCalled();
        const archived = await read(clients[0], { ownerFirst: false, archived: true });
        // Removing a heartbeat's operator label changes its accepted classification.
        const archivedIds = revision === 0 ? ["d"] : [];
        expectPage(archived, archivedIds, archivedIds.length);
        // Cold archives can acquire metadata; warm reads and filter changes reuse those facts.
        predicate.mockClear();
        const warmArchive = await read(clients[0], { ownerFirst: false, archived: true });
        expect(warmArchive.sessions.map((row) => row.sessionId)).toEqual(archivedIds);
        expect(predicate).not.toHaveBeenCalled();
        const unarchived = await read(clients[0]);
        expect(unarchived.sessions.map((row) => row.sessionId)).toEqual(golden[revision]![0]!.ids);
        expect(predicate).not.toHaveBeenCalled();
        if (revision === 0) {
          writeListEntry("agent:main:a", {
            ...store["agent:main:a"],
            label: undefined,
            archivedAt: 2,
          });
          writeListEntry("agent:main:b", { ...store["agent:main:b"], visibility: "shared" });
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
      predicate.mockRestore();
      selectEntries.mockRestore();
      projection.dispose();
      release();
    }
  });
});

test("refreshes cached lists after placement readiness and refuses disposed responses", async () => {
  await withStateDirEnv("openclaw-list-placement-readiness-", async () => {
    const cfg = { agents: { entries: { main: {} } } };
    initialize(cfg);
    const alice = viewer(ensureProfileForEmail("alice@placement.example").id);
    const bob = ensureProfileForEmail("bob@placement.example");
    alice.connect.scopes = ["operator.admin"];
    const initialNow = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
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
    const selected = vi.spyOn(projection, "selectEntries");
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
      expect(result.sessions.map((row) => row.sessionId)).toEqual(["stable"]);
      expect(result.sessions[0]?.sharingRole).toBe("viewer");
      // The publication can leave unselected archives dirty; warm its completed revision.
      await read();
      selected.mockClear();
      readProjection.mockClear();
      const warm = await read();
      expect(warm.sessions.map((row) => row.sessionId)).toEqual(["stable"]);
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
      selected.mockRestore();
      release();
      clock.mockRestore();
    }
  });
});

test("shares concurrent list selection across row modes and refilters only published partitions", async () => {
  await withStateDirEnv("openclaw-list-selection-repeat-", async () => {
    const cfg = { agents: { entries: { main: {} } } };
    initialize(cfg);
    const alice = viewer(ensureProfileForEmail("alice@selection.example").id);
    const bob = viewer(ensureProfileForEmail("bob@selection.example").id);
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
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
    const opts = { limit: 2, activeMinutes: 1 };
    const read = (rowMode: "compact" | "sidebar", client = alice) =>
      listProjectedSessions({
        projection,
        client,
        acceptsSerializedJson: true,
        opts: { ...opts, rowMode },
      });
    try {
      expect((await read("compact")).sessions.map((row) => row.sessionId)).toEqual([
        "s127",
        "s126",
      ]);
      using owner = vi.spyOn(projection.state.rowContext.identityProjection!, "owner");
      const repeated = await Promise.all(
        Array.from({ length: 8 }, (_, i) => read(i % 2 ? "compact" : "sidebar")),
      );
      expect(repeated.map((result) => result.totalCount)).toEqual(Array(8).fill(128));
      expect(owner).not.toHaveBeenCalled();
      writeListEntry("agent:main:selection-0", {
        ...store["agent:main:selection-0"]!,
        updatedAt: now + 200,
        visibility: "draft",
      });
      const changed = await read("compact");
      expectPage(changed, ["s0", "s127"], 128);
      expect(owner.mock.calls.length).toBeLessThan(32);
      const other = await read("compact", bob);
      expectPage(other, ["s127", "s126"], 127);
      // An exact publication must not hide an expired retained partition.
      clock.mockReturnValue(now + 60_128);
      writeListEntry("agent:main:selection-1", {
        ...store["agent:main:selection-1"]!,
        updatedAt: Date.now(),
      });
      const expired = await read("compact");
      expectPage(expired, ["s1", "s0"], 2);
      setDisplayName(alice.authenticatedUserProfile!.profileId, "Renamed Alice");
      writeListEntry("agent:main:selection-127", {
        ...store["agent:main:selection-127"]!,
        updatedAt: Date.now(),
      });
      const renamed = await read("compact");
      expect(renamed.totalCount).toBe(3);
      expect(
        renamed.owners?.find((actor) => actor.id === alice.authenticatedUserProfile!.profileId)
          ?.label,
      ).toBe("Renamed Alice");
    } finally {
      projection.dispose();
      release();
      clock.mockRestore();
    }
  });
});

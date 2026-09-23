import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { queryObjects } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as visibility from "../shared/session-list-visibility.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { projectSessionPeople } from "./session-identity-projection.js";
import type { SessionListDiagnostics, SessionListPhase } from "./session-list-diagnostics.types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
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

test.skipIf(process.env.OPENCLAW_BENCH_SESSION_VIEWERS !== "1")(
  "benchmarks the resident list and serialization for 50 distinct viewers",
  async () => {
    await withStateDirEnv("openclaw-list-viewers-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const clients = Array.from({ length: 50 }, (_, index) =>
        viewer(ensureProfileForEmail(`viewer-${index}@example.com`).id),
      );
      const includePeople = process.env.OPENCLAW_BENCH_SESSION_PEOPLE === "1";
      const store: Record<string, SessionEntry> = Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [
          `agent:main:viewer-row-${index}`,
          {
            sessionId: `viewer-row-${index}`,
            updatedAt: index + 1,
            lastInteractionAt: index + 1,
            visibility: index % 10 === 0 ? "draft" : "shared",
            createdActor: {
              type: "human",
              source: "profile",
              id: clients[index % clients.length]!.authenticatedUserProfile!.profileId,
            },
            ...(includePeople
              ? {
                  participants: [1, 2, 3].map((offset) => ({
                    identity: {
                      type: "profile" as const,
                      id: clients[(index + offset) % clients.length]!.authenticatedUserProfile!
                        .profileId,
                    },
                    promptedAt: 1,
                  })),
                }
              : {}),
            ...(index >= 2_300 ? { archivedAt: 1 } : {}),
          },
        ]),
      );
      writeResidentEntries(store);
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const opts = includePeople
        ? {
            archived: "all" as const,
            includeGlobal: true,
            includeUnknown: true,
            includePeople: true,
            excludeSubagents: true,
            includeActivitySummary: true,
            includeDerivedTitles: true,
            sortBy: "activity" as const,
            limit: 100,
          }
        : { limit: 60, ownerFirst: true, excludeCron: true, excludeSystem: true };
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const rpcSamples: number[] = [];
      const rpc = async (client: GatewayClient) => {
        let replied = false;
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "benchmark", method: "sessions.list" },
          params: opts,
          client,
          context,
          isWebchatConnect: () => false,
          respond(ok, result) {
            if (!ok) {
              throw new Error("sessions.list benchmark failed");
            }
            JSON.stringify(result);
            replied = true;
          },
        });
        if (!replied) {
          throw new Error("sessions.list did not reply");
        }
      };
      try {
        await projection.ensureMaterialized();
        if (includePeople) {
          const identity = expectDefined(
            projection.state.rowContext.identityProjection,
            "resident identity projection",
          );
          const cachedPeople = identity.people;
          const comparison = [];
          let uncachedHeap = 0;
          try {
            for (const cached of [false, true, false, true]) {
              identity.people = cached ? cachedPeople : projectSessionPeople;
              for (const client of clients) {
                await rpc(client);
              }
              queryObjects(Session);
              const retainedHeap = process.memoryUsage().heapUsed;
              if (comparison.length === 0) {
                uncachedHeap = retainedHeap;
              }
              const times = [];
              const cpu = process.cpuUsage();
              for (const client of clients) {
                const start = performance.now();
                await rpc(client);
                times.push(performance.now() - start);
              }
              const used = process.cpuUsage(cpu);
              comparison.push({
                cached,
                medianMs: times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)],
                cpuMsPerCall: (used.user + used.system) / 1000 / times.length,
                retainedHeapDeltaBytes: retainedHeap - uncachedHeap,
              });
            }
          } finally {
            identity.people = cachedPeople;
          }
          console.log(JSON.stringify({ peopleComparison: comparison }));
        }
        for (const client of clients) {
          await rpc(client);
        }
        const rpcCpuStarted = process.threadCpuUsage();
        for (let round = 0; round < 5; round++) {
          for (const client of clients) {
            const start = performance.now();
            await rpc(client);
            rpcSamples.push(performance.now() - start);
          }
        }
        const rpcCpu = process.threadCpuUsage(rpcCpuStarted);
        const samples: number[] = [];
        const phases = new Map<SessionListPhase | "serialize" | "total", number>();
        for (let round = 0; round < 5; round++) {
          for (const client of clients) {
            let last = performance.now();
            const started = last;
            const diagnostics: SessionListDiagnostics = {
              startSyncCpu: () => undefined,
              finishSyncCpu: () => {},
              mark(phase) {
                const now = performance.now();
                phases.set(phase, (phases.get(phase) ?? 0) + now - last);
                last = now;
              },
              projection: {
                prepareSyncMs: 0,
                rowSyncMs: 0,
                yieldWaitMs: 0,
                yieldCount: 0,
                selectedRowCount: 0,
                dirtyRowCount: 0,
                materializedRowCount: 0,
                reusedRowCount: 0,
              },
            };
            const result = await listProjectedSessions({ projection, client, opts, diagnostics });
            expect(result.count).toBeGreaterThanOrEqual(60);
            const serialize = performance.now();
            JSON.stringify(result);
            phases.set("serialize", (phases.get("serialize") ?? 0) + performance.now() - serialize);
            samples.push(performance.now() - started);
          }
        }
        const inspector = new Session();
        inspector.connect();
        let cloneMs = 0;
        const clone = globalThis.structuredClone;
        const clones = vi
          .spyOn(globalThis, "structuredClone")
          .mockImplementation((value, options) => {
            const start = performance.now();
            try {
              return clone(value, options);
            } finally {
              cloneMs += performance.now() - start;
            }
          });
        try {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
          for (let round = 0; round < 4; round++) {
            for (const client of clients) {
              JSON.stringify(await listProjectedSessions({ projection, client, opts }));
            }
          }
          const { profile } = await inspector.post("Profiler.stop");
          const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
          const self = new Map<string, number>();
          profile.samples?.forEach((id, index) => {
            const name = nodes.get(id)?.callFrame.functionName || "(anonymous)";
            self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1_000);
          });
          console.log(
            JSON.stringify({
              rows: 5_000,
              includePeople,
              liveRows: 2_300,
              viewers: clients.length,
              calls: samples.length,
              meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
              medianMs: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
              rpcMeanMs: rpcSamples.reduce((sum, value) => sum + value, 0) / rpcSamples.length,
              rpcMedianMs: rpcSamples.toSorted((a, b) => a - b)[Math.floor(rpcSamples.length / 2)],
              rpcThreadCpuMsPerCall: (rpcCpu.user + rpcCpu.system) / 1_000 / rpcSamples.length,
              phaseMs: Object.fromEntries(
                [...phases].map(([key, ms]) => [key, ms / samples.length]),
              ),
              profiledCalls: 200,
              cloneCalls: clones.mock.calls.length,
              cloneMsPerCall: cloneMs / 200,
              profileSelfMsPerCall: Object.fromEntries(
                [...self]
                  .toSorted((a, b) => b[1] - a[1])
                  .slice(0, 20)
                  .map(([name, ms]) => [name, ms / 200]),
              ),
            }),
          );
        } finally {
          clones.mockRestore();
          inspector.disconnect();
        }
      } finally {
        projection.dispose();
        release();
      }
    });
  },
  120_000,
);

test("preserves viewer pages across publications while bounding shared predicate work", async () => {
  await withStateDirEnv("openclaw-list-viewer-golden-", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = {
      agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
    };
    resetConfigRuntimeState();
    setRuntimeConfigSnapshot(cfg);
    const clients = ["alice", "bob", "admin"].map((name) =>
      viewer(ensureProfileForEmail(`${name}@example.com`).id),
    );
    clients[2]!.connect.scopes = ["operator.admin"];
    const entry = (sessionId: string, owner: number, updatedAt: number): SessionEntry => ({
      sessionId,
      updatedAt,
      lastInteractionAt: 20 - updatedAt,
      createdActor: {
        type: "human",
        source: "profile",
        id: clients[owner]!.authenticatedUserProfile!.profileId,
      },
    });
    const store = {
      "agent:main:a": entry("a", 0, 1),
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
    const golden = [
      [
        {
          ids: ["b", "a", "c"],
          order: ["b", "c", "f", "a"],
          activityOrder: ["a", "f", "c", "b"],
          total: 4,
        },
        { ids: ["c", "f"], order: ["c", "f", "a"], activityOrder: ["a", "f", "c"], total: 3 },
        {
          ids: ["f", "b", "c"],
          order: ["b", "c", "f", "a"],
          activityOrder: ["a", "f", "c", "b"],
          total: 4,
        },
      ],
      [
        { ids: ["b", "d"], order: ["d", "b"], activityOrder: ["b", "d"], total: 2 },
        { ids: ["d", "b"], order: ["d", "b"], activityOrder: ["b", "d"], total: 2 },
        { ids: ["f", "d"], order: ["f", "d", "b"], activityOrder: ["b", "d", "f"], total: 3 },
      ],
    ];
    try {
      for (let revision = 0; revision < 2; revision++) {
        // The first viewer primes only viewer-independent membership.
        await listProjectedSessions({ projection, client: clients[0], opts });
        predicate.mockClear();
        selectEntries.mockClear();
        for (const [index, client] of clients.entries()) {
          const result = await listProjectedSessions({ projection, client, opts });
          const expected = golden[revision]![index]!;
          expect({
            ids: result.sessions.map((row) => row.sessionId),
            total: result.totalCount,
          }).toEqual({ ids: expected.ids, total: expected.total });
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
            const next = await listProjectedSessions({
              projection,
              client,
              opts: { ...opts, ...page },
            });
            expect(next.sessions.map((row) => row.sessionId)).toEqual(
              expected.order.slice(page.offset, page.offset + page.limit),
            );
            expect(next.totalCount).toBe(expected.total);
          }
          const activity = await listProjectedSessions({
            projection,
            client,
            opts: { ...opts, ownerFirst: false, sortBy: "activity", includeActivitySummary: false },
          });
          expect(activity.sessions.map((row) => row.sessionId)).toEqual(
            expected.activityOrder.slice(0, opts.limit),
          );
          expect(activity.totalCount).toBe(expected.total);
          const people = await listProjectedSessions({
            projection,
            client,
            opts: { ...opts, ownerFirst: false, sortBy: "updatedAt", includePeople: true },
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
        const searched = await listProjectedSessions({
          projection,
          client: clients[0],
          opts: { ...opts, ownerFirst: false, search: "agent:main:b" },
        });
        expect(searched.sessions.map((row) => row.sessionId)).toEqual(["b"]);
        const clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
        try {
          const recent = () =>
            listProjectedSessions({
              projection,
              client: clients[0],
              opts: { ...opts, activeMinutes: 1 },
            });
          expect((await recent()).totalCount).toBe(golden[revision]![0]!.total);
          clock.mockReturnValue(120_000);
          expect((await recent()).sessions).toEqual([]);
        } finally {
          clock.mockRestore();
        }
        expect(selectEntries.mock.calls.length).toBe(0);
        expect(predicate).not.toHaveBeenCalled();
        const archived = await listProjectedSessions({
          projection,
          client: clients[0],
          opts: { ...opts, ownerFirst: false, archived: true },
        });
        expect(archived.sessions.map((row) => row.sessionId)).toEqual([revision === 0 ? "d" : "a"]);
        expect(archived.totalCount).toBe(1);
        expect(predicate).toHaveBeenCalled();
        predicate.mockClear();
        const unarchived = await listProjectedSessions({ projection, client: clients[0], opts });
        expect(unarchived.sessions.map((row) => row.sessionId)).toEqual(golden[revision]![0]!.ids);
        expect(predicate).toHaveBeenCalled();
        if (revision === 0) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:a" },
            { ...store["agent:main:a"], archivedAt: 2 },
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:b" },
            { ...store["agent:main:b"], visibility: "shared" },
          );
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            archiveTranscript: false,
            target: { canonicalKey: "agent:main:c", storeKeys: ["agent:main:c"] },
          });
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:d" },
            entry("d", 1, 11),
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:f" },
            { ...entry("f", 2, 12), visibility: "draft" },
          );
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
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = { agents: { entries: { main: {} } } };
    resetConfigRuntimeState();
    setRuntimeConfigSnapshot(cfg);
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
      createdActor: { type: "human", source: "profile", id: bob.id },
    });
    const store = Object.fromEntries(
      ["admin-only", "publication", "aged", "stable"].map((id) => [`agent:main:${id}`, entry(id)]),
    );
    writeResidentEntries(store);
    const empty: WorkerSessionPlacementProjection = {
      placements: new Map(),
      moves: new Map(),
      environments: new Map(),
      workspaceResultReconcilingSessionIds: new Set(),
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
    let pending: ReturnType<typeof listProjectedSessions> | undefined;
    try {
      // Populate common selection while all rows and their placement facts remain cold.
      expect((await listProjectedSessions({ projection, opts: {} })).sessions).toEqual([]);
      selected.mockClear();
      pending = listProjectedSessions({
        projection,
        client: alice,
        opts: { archived: true, activeMinutes: 1 },
      });
      await entered.promise;
      alice.connect.scopes = ["operator.read"];
      clock.mockReturnValue(initialNow + 60_001);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:publication" },
        { ...entry("publication"), updatedAt: Date.now(), visibility: "draft" },
      );
      hold = false;
      paused.resolve(empty);
      const result = await pending;
      expect(result.sessions.map((row) => row.sessionId)).toEqual(["stable"]);
      expect(result.sessions[0]?.sharingRole).toBe("viewer");
      // The publication can leave unselected archives dirty; warm its completed revision.
      await listProjectedSessions({
        projection,
        client: alice,
        opts: { archived: true, activeMinutes: 1 },
      });
      selected.mockClear();
      readProjection.mockClear();
      const warm = await listProjectedSessions({
        projection,
        client: alice,
        opts: { archived: true, activeMinutes: 1 },
      });
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

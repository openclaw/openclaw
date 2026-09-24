import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  persistSubagentRunsToDiskOrThrow,
  withSubagentRunReadSnapshot,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { RespondFn } from "./server-methods/types.js";
import { makeGatewayClient } from "./server-request-context.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as materialization from "./session-row-projection-materialize.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { seedSessionRowProjectionTranscriptFixture } from "./session-row-projection.transcript-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

it("settles a registry revision after persisting an already absent run", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      setRuntimeConfigSnapshot(cfg);
      clearSubagentRunsReadCacheForTest();
      const target = { agentId: "main", sessionKey: "agent:main:registry-revision" };
      replaceSessionEntrySync(target, { sessionId: "registry-revision", updatedAt: 1 });
      const createDrain = projectionWork.createSessionProjectionDrain;
      let remainingRefreshes: number | undefined;
      vi.spyOn(projectionWork, "createSessionProjectionDrain").mockImplementation((owner) =>
        createDrain({
          ...owner,
          refresh: () => {
            // A regressed microtask loop would starve Vitest's own timeout.
            if (remainingRefreshes !== undefined && remainingRefreshes-- === 0) {
              throw new Error("Session projection did not settle the registry revision");
            }
            return owner.refresh();
          },
        }),
      );
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const releaseForeground = projectionWork.retainSessionListForegroundWork();
      try {
        await projection.ensureMaterialized();
        expect(projection.needsMaterialization).toBe(false);

        persistSubagentRunsToDiskOrThrow(subagentRuns, ["already-absent-run"]);

        expect(projection.dirtyRowCount).toBe(0);
        remainingRefreshes = 10;
        await projection.ensureMaterialized();
        expect(projection.needsMaterialization).toBe(false);
        expect(
          projection.snapshot({ agentId: target.agentId, key: target.sessionKey }).row,
        ).toMatchObject({
          sessionId: "registry-revision",
        });
      } finally {
        projection.dispose();
        releaseForeground();
      }
    },
  );
});

it.each(["existing", "new"] as const)(
  "retains a %s archive publication while unrelated compact recovery is pending",
  async (kind) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { list: [{ id: "main", default: true }] } };
        setRuntimeConfigSnapshot(cfg);
        clearSubagentRunsReadCacheForTest();
        const key = "agent:main:archive-during-recovery";
        const target = { agentId: "main", sessionKey: key };
        const sessionId = "archive-during-recovery";
        const anchorKey = "agent:main:archive-recovery-anchor";
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: anchorKey },
          { sessionId: "archive-recovery-anchor", updatedAt: 1 },
        );
        if (kind === "existing") {
          replaceSessionEntrySync(target, { sessionId, updatedAt: 1 });
        }
        const previous = createSubagentRunRecord({
          runId: "previous-unrelated-run",
          childSessionKey: "agent:main:unrelated-child",
          requesterSessionKey: "agent:main:unrelated-parent",
          generation: 1,
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([[previous.runId, previous]]));
        const releaseForeground = projectionWork.retainSessionListForegroundWork();
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalog: async () => [],
        });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
        let recovery: Promise<unknown> | undefined;
        try {
          projection = await createSessionRowProjection({ cfg, context, modelCatalog: [] });
          bindSessionRowProjection(context, () => projection);
          await projection.ensureMaterialized();
          expect(projection.capture({ agentId: "main", key })?.entry?.sessionId).toBe(
            kind === "existing" ? sessionId : undefined,
          );
          const executeRead = stateReads.executeExistingOpenClawStateRead;
          vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
            async (...args) => {
              const result = await executeRead(...args);
              if (args[1].type === "subagents.sessionList") {
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          );
          const replacement = { ...previous, runId: "replacement-unrelated-run", generation: 2 };
          saveSubagentRegistryToSqlite(new Map([[replacement.runId, replacement]]));
          recovery = withSubagentRunReadSnapshot(
            new Map(),
            (snapshot) => ({
              runIds: [...snapshot.values()]
                .filter((run) => run.childSessionKey === previous.childSessionKey)
                .map((run) => run.runId),
              sessionKeys: [],
            }),
            (selection) => selection.runIds,
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await entered.promise;
          expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
          if (kind === "existing") {
            const respond = vi.fn<RespondFn>();
            await sessionMutationHandlers["sessions.patch"]!({
              req: { type: "req", id: "archive-during-recovery", method: "sessions.patch" },
              params: { key, archived: true, expectedSessionId: sessionId },
              client: makeGatewayClient({
                connId: "archive-during-recovery-client",
                clientId: "openclaw-control-ui",
                mode: "webchat",
                scopes: ["operator.read", "operator.write"],
              }),
              isWebchatConnect: () => false,
              context,
              respond,
            });
            expect(respond).toHaveBeenCalledTimes(1);
            expect(respond.mock.calls[0]?.[0]).toBe(true);
          } else {
            replaceSessionEntrySync(target, { sessionId, updatedAt: 2, archivedAt: 2 });
          }
          const archived = loadSessionEntry(target);
          expect(archived).toMatchObject({ sessionId, archivedAt: expect.any(Number) });
          expect(projection.sharingTarget({ agentId: "main", key })?.entry).toMatchObject({
            sessionId,
            archivedAt: archived?.archivedAt,
          });
          release.resolve();
          expect(await recovery).toEqual({ value: [replacement.runId] });
          await projection.ensureMaterialized();
          const active = await listProjectedSessions({ projection, opts: { archived: false } });
          const archives = await listProjectedSessions({ projection, opts: { archived: true } });
          expect(active.sessions.map((row) => row.key)).toEqual([anchorKey]);
          expect(archives.sessions).toEqual([
            expect.objectContaining({ key, sessionId, archivedAt: archived?.archivedAt }),
          ]);
        } finally {
          release.resolve();
          await recovery;
          projection?.dispose();
          releaseForeground();
        }
      },
    );
  },
);

it.each(["exact", "bulk"] as const)(
  "reprepares subagent facts invalidated during a pending %s placement read",
  async (kind) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { entries: { main: {} } } };
        setRuntimeConfigSnapshot(cfg);
        const parent = "agent:main:prepared-parent";
        const child = "agent:main:prepared-child";
        for (const key of [parent, child]) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: key },
            {
              sessionId: key,
              updatedAt: 1,
              ...(key === child ? { parentSessionKey: parent } : {}),
              ...(kind === "exact" ? { archivedAt: 1 } : {}),
            },
          );
        }
        const run: SubagentRunRecord = {
          runId: "pending-placement",
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterAgentId: "main",
          requesterDisplayKey: "parent",
          task: "Synthetic pending placement",
          cleanup: "keep",
          createdAt: Date.now(),
          execution: { status: "running", startedAt: Date.now() },
          completion: { required: false },
          delivery: { status: "not_required" },
        };
        subagentRuns.set(run.runId, run);
        persistSubagentRunsToDiskOrThrow(subagentRuns);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let holdNextRead = false;
        const readProjection = vi.fn(
          async (_ids: readonly string[]): Promise<WorkerSessionPlacementProjection> => {
            if (holdNextRead) {
              holdNextRead = false;
              entered.resolve();
              await release.promise;
            }
            return {
              placements: new Map(),
              moves: new Map(),
              environments: new Map(),
              workspaceResultReconcilingSessionIds: new Set(),
            };
          },
        );
        const projection = await createSessionRowProjection({
          cfg,
          placementFactsReader: { readProjection },
        });
        let observed: Promise<unknown> | undefined;
        try {
          await projection.ensureMaterialized();
          if (kind === "exact") {
            expect(readProjection).not.toHaveBeenCalled();
          }
          const query = { agentId: "main", key: child };
          const consume = (read: SessionRowReadView) => {
            const row = read.describe(query);
            return {
              owner: row && read.present(row).controlOwnerSessionKey,
              ancestors: row && projection.ancestorRows(row)?.map((entry) => entry.key),
            };
          };
          holdNextRead = true;
          if (kind === "bulk") {
            sessionChanges.emit({ all: true, scope: "worker-placements" });
          }
          const reading =
            kind === "exact"
              ? projection.withPreparedExactRows(() => [query], consume, {
                  includeAncestors: true,
                })
              : projection
                  .ensureMaterialized()
                  .then(() => ({ kind: "complete", value: consume(projection) }));
          observed = reading.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await entered.promise;
          clearSubagentRunsReadCacheForTest();
          expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
          release.resolve();
          expect(await observed).toEqual({
            value: { kind: "complete", value: { owner: parent, ancestors: [parent] } },
          });
          if (kind === "bulk") {
            let sameFrame = true;
            const warm = projection.withPreparedExactRows(
              () => [query],
              () => sameFrame,
            );
            sameFrame = false;
            expect(await warm).toEqual({ kind: "complete", value: true });
          }
        } finally {
          release.resolve();
          await observed;
          projection.dispose();
        }
      },
    );
  },
);

it("reuses the subagent index across a 2,048-session drain with unrelated writes and refreshes a changed run", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const count = seedSessionRowProjectionTranscriptFixture();
    for (let index = 1; index < count; index++) {
      const run: SubagentRunRecord = {
        runId: `run-${index}`,
        childSessionKey: `agent:main:legacy-${index}`,
        requesterSessionKey: "agent:main:legacy-0",
        requesterDisplayKey: "parent",
        task: "Synthetic task",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      subagentRuns.set(run.runId, run);
    }
    const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
    const memoryBefore = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const projection = await createSessionRowProjection({ cfg });
    let writes = 0;
    let writesDuringDrain = 0;
    let drainSettled = false;
    const producer = (async () => {
      for (let update = 1; update <= 32; update++) {
        await nextTurn();
        if (!drainSettled) {
          writesDuringDrain++;
        }
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:legacy-2047" },
          { sessionId: "legacy-2047", updatedAt: count + update, label: `Update ${update}` },
        );
        writes++;
        if (update === 12) {
          const run = subagentRuns.get("run-1")!;
          subagentRuns.set(run.runId, {
            ...run,
            execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
          });
          persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
        }
      }
    })();
    const drain = (async () => {
      await projection.ensureMaterialized();
      drainSettled = true;
    })();
    try {
      await Promise.all([producer, drain]);
      // The bounded drain may finish before all producer turns; join its later publications too.
      await projection.ensureMaterialized();
      const elapsed = process.threadCpuUsage(cpu);
      const memoryAfter = process.memoryUsage();
      console.log(
        JSON.stringify({
          count,
          writes,
          writesDuringDrain,
          indexBuilds: builds.mock.calls.length,
          drainAndPublicationsMs: performance.now() - started,
          drainAndPublicationsThreadCpuMs: (elapsed.user + elapsed.system) / 1000,
          heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
          rssDelta: memoryAfter.rss - memoryBefore.rss,
        }),
      );
      expect(projection.selectEntries().filter(ready)).toHaveLength(count);
      expect(projection.dirtyRowCount).toBe(0);
      expect(writes).toBe(32);
      expect(writesDuringDrain).toBeGreaterThan(0);
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:legacy-2047" }).row?.label,
      ).toBe("Update 32");
      expect(projection.snapshot({ agentId: "main", key: "agent:main:legacy-1" }).row?.status).toBe(
        "done",
      );
      expect(builds).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.allSettled([producer, drain]);
      projection.dispose();
    }
  });
}, 120_000);

it.each(
  (["ownership", "broad-ownership", "retirement", "clear", "persistence"] as const).flatMap(
    (publication) => [false, true].map((archived) => ({ publication, archived })),
  ),
)(
  "refreshes subagent facts before synchronous $publication observers (archived=$archived)",
  async ({ publication, archived }) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { list: [{ id: "main", default: true }] } };
        const child = "agent:main:child",
          parent = "agent:main:parent",
          nextParent = "agent:main:next";
        for (const key of [child, parent, nextParent]) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: key },
            {
              sessionId: key,
              updatedAt: 1,
              ...(archived && key === child ? { archivedAt: 1 } : {}),
            },
          );
        }
        const run: SubagentRunRecord = {
          runId: "run",
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterAgentId: "main",
          swarmRequesterSessionKey: parent,
          groupId: "group",
          collect: true,
          requesterDisplayKey: "parent",
          task: "Synthetic task",
          cleanup: "keep",
          createdAt: 1,
          execution: { status: "running", startedAt: 1 },
          completion: { required: false },
          delivery: { status: "not_required" },
        };
        subagentRuns.set(run.runId, run);
        const projection = await createSessionRowProjection({ cfg });
        await projection.ensureMaterialized();
        const reads = vi.spyOn(materialization, "readSessionRowEntry");
        const snapshot = () =>
          archived ? undefined : projection.snapshot({ agentId: "main", key: child }).row;
        let observed: ReturnType<typeof snapshot> | undefined;
        let observedParents: string[][] | undefined;
        const stop = sessionChanges.subscribe(() => {
          observed = snapshot();
          observedParents = [parent, nextParent].map((parentSessionKey) =>
            projection.selectEntries({ parentSessionKey }).map((row) => row.key),
          );
        });
        try {
          expect(snapshot()?.controlOwnerSessionKey).toBe(archived ? undefined : parent);
          const moved =
            publication === "ownership" ||
            publication === "broad-ownership" ||
            publication === "persistence";
          if (moved) {
            const replacement = {
              ...run,
              requesterSessionKey: nextParent,
              swarmRequesterSessionKey: nextParent,
            };
            subagentRuns.set(run.runId, replacement);
            expect(snapshot()?.controlOwnerSessionKey).toBe(archived ? undefined : parent);
            if (publication === "broad-ownership") {
              publishSubagentRunChanges();
            } else if (publication === "ownership") {
              subagentRuns.commitOwnership(replacement);
            } else {
              persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
            }
          } else if (publication === "retirement") {
            subagentRuns.delete(run.runId);
            expect(snapshot()?.controlOwnerSessionKey).toBe(archived ? undefined : parent);
            subagentRuns.confirmRetirement(run);
          } else {
            subagentRuns.clear();
          }
          expect(observed?.key).toBe(archived ? undefined : child);
          expect(observed?.controlOwnerSessionKey).toBe(
            !archived && moved ? nextParent : undefined,
          );
          expect(observedParents).toEqual([[], moved ? [child] : []]);
          if (archived) {
            expect(
              projection.capture({ agentId: "main", key: child })?.materialized,
            ).toBeUndefined();
          }
          await projection.ensureMaterialized();
          expect(
            projection.snapshot({ agentId: "main", key: parent }).row?.childSessions,
          ).toBeUndefined();
          expect(
            projection.snapshot({ agentId: "main", key: nextParent }).row?.childSessions,
          ).toEqual(moved ? [child] : undefined);
          if (publication === "broad-ownership" || publication === "clear") {
            expect(
              projection.snapshot({ agentId: "main", key: parent }).row?.swarm,
            ).toBeUndefined();
            const swarm = projection.snapshot({ agentId: "main", key: nextParent }).row?.swarm;
            if (moved) {
              expect(swarm?.groups).toEqual([
                expect.objectContaining({ groupId: "group", running: 1 }),
              ]);
            } else {
              expect(swarm).toBeUndefined();
            }
            expect(reads).not.toHaveBeenCalled();
          }
        } finally {
          stop();
          projection.dispose();
        }
      },
    );
  },
);

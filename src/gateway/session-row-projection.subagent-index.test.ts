import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { RespondFn } from "./server-methods/types.js";
import { makeGatewayClient } from "./server-request-context.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as materialization from "./session-row-projection-materialize.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

it("settles a registry revision after persisting an already absent run", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { entries: { main: {} } } };
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

        persistRegistryFixture(subagentRuns, ["already-absent-run"]);

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

it.each([
  "existing",
  "new",
  "native replacement",
  "worker replacement",
  "native reset",
  "worker reset",
] as const)(
  "retains a %s archive publication while cold compact preparation is pending",
  async (kind) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { entries: { main: {} } } };
        setRuntimeConfigSnapshot(cfg);
        clearSubagentRunsReadCacheForTest();
        const key = "agent:main:archive-during-recovery";
        const target = { agentId: "main", sessionKey: key };
        const sessionId = "archive-during-recovery";
        const replacesIdentity = kind.endsWith("replacement");
        const resetsIdentity = kind.endsWith("reset");
        const changesIdentity = replacesIdentity || resetsIdentity;
        const previousSessionId = replacesIdentity ? "archive-before-replacement" : sessionId;
        const anchorKey = "agent:main:archive-recovery-anchor";
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: anchorKey },
          { sessionId: "archive-recovery-anchor", updatedAt: 1 },
        );
        if (kind !== "new") {
          replaceSessionEntrySync(target, {
            sessionId: previousSessionId,
            updatedAt: 1,
            ...(resetsIdentity ? { lifecycleRevision: "before-reset" } : {}),
          });
        }
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
          const captured = projection.capture({ agentId: "main", key });
          expect(captured?.entry?.sessionId).toBe(kind === "new" ? undefined : previousSessionId);
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
          clearSubagentRunsReadCacheForTest();
          recovery = prepareSubagentSessionListReadCache().then(
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
          } else if (changesIdentity) {
            const entry = {
              sessionId,
              updatedAt: 2,
              archivedAt: 2,
              ...(resetsIdentity ? { lifecycleRevision: "after-reset" } : {}),
            };
            if (kind.startsWith("worker")) {
              expect(isMainThread).toBe(true);
              const publications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
              const stop = onSessionIdentityMutation((mutation) => {
                if ("current" in mutation && mutation.current.sessionKeys.includes(key)) {
                  publications.push(readPreparedSessionEntryChange(mutation, key));
                }
              });
              try {
                await applySessionEntryExactReplacements({
                  agentId: target.agentId,
                  storePath: captured!.storeTarget.storePath,
                  sessionKeys: [key],
                  update: ([row]) => ({
                    result: undefined,
                    replacements: [{ sessionKey: key, entry: { ...row!.entry, ...entry } }],
                  }),
                });
                expect(publications).toEqual([
                  expect.objectContaining({
                    entry: expect.objectContaining(entry),
                    source: expect.objectContaining({ revision: expect.any(Number) }),
                  }),
                ]);
              } finally {
                stop();
              }
            } else {
              replaceSessionEntrySync(target, entry);
            }
          } else {
            replaceSessionEntrySync(target, { sessionId, updatedAt: 2, archivedAt: 2 });
          }
          const archived = loadSessionEntry(target);
          expect(archived).toMatchObject({ sessionId, archivedAt: expect.any(Number) });
          if (kind === "native reset") {
            expect(projection.sharingTarget({ agentId: "main", key })).toBeNull();
          } else {
            expect(projection.sharingTarget({ agentId: "main", key })?.entry).toMatchObject({
              sessionId,
              archivedAt: archived?.archivedAt,
            });
          }
          if (changesIdentity) {
            expect(captured).toBeDefined();
            expect(projection.isCurrent(captured!)).toBe(false);
            const pending = projection.capture({ agentId: "main", key });
            expect(pending?.entry).toBeUndefined();
            expect(pending?.storedEntry).toMatchObject({
              sessionId,
              archivedAt: archived?.archivedAt,
              ...(resetsIdentity ? { lifecycleRevision: "after-reset" } : {}),
            });
            if (replacesIdentity) {
              expect(
                projection.findBySessionId({ agentId: "main", sessionId: previousSessionId }),
              ).toEqual([]);
            }
          }
          release.resolve();
          expect(await recovery).toEqual({ value: undefined });
          await projection.ensureMaterialized();
          if (changesIdentity) {
            expect(projection.isCurrent(captured!)).toBe(false);
            expect(projection.capture({ agentId: "main", key })?.entry).toMatchObject({
              sessionId,
              archivedAt: archived?.archivedAt,
              ...(resetsIdentity ? { lifecycleRevision: "after-reset" } : {}),
            });
          }
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

it.each([
  { publication: "broad-ownership", archived: true },
  { publication: "clear", archived: false },
  { publication: "persistence", archived: false },
] as const)(
  "refreshes subagent facts before synchronous $publication observers (archived=$archived)",
  async ({ publication, archived }) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { entries: { main: {} } } };
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
        if (archived) {
          persistRegistryFixture(subagentRuns);
        }
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
          const moved = publication !== "clear";
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
            } else {
              persistRegistryFixture(subagentRuns, [run.runId]);
            }
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

it("keeps current row facts when the subagent snapshot changes during a list", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const scope = { agentId: "main", sessionKey: "agent:main:dashboard:registry-refresh" };
      const entry = { sessionId: "registry-refresh", updatedAt: 1, label: "Previous" };
      replaceSessionEntrySync(scope, entry);
      const release = projectionWork.retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        const reads: string[][] = [];
        const readDatabases = history.withSessionHistoryWorkerDatabases;
        vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
          (databases, consume, lane) =>
            readDatabases(
              databases,
              (owners) =>
                consume(
                  owners.map((owner) => ({
                    ...owner,
                    async readRowFacts(input) {
                      const reply = await owner.readRowFacts(input);
                      reads.push([...input.sessionKeys]);
                      if (reads.length === 1) {
                        const previous = getSubagentSessionListReadSnapshotIdentity();
                        const run = createSubagentRunRecord({
                          runId: "unrelated-refresh-run",
                          childSessionKey: "agent:main:unrelated-child",
                          requesterSessionKey: "agent:main:unrelated-parent",
                          generation: 1,
                          completion: { required: false },
                          delivery: { status: "not_required" },
                        });
                        persistRegistryFixture(new Map([[run.runId, run]]));
                        expect(getSubagentSessionListReadSnapshotIdentity()).not.toBe(previous);
                      }
                      return reply;
                    },
                  })),
                ),
              lane,
            ),
        );
        replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "Current" });
        sessionChanges.emit({ ...scope, factsInvalidated: true });
        const result = await listProjectedSessions({ projection, opts: { limit: 1 } });
        expect(result.sessions).toEqual([
          expect.objectContaining({ key: scope.sessionKey, label: "Current" }),
        ]);
        expect(reads).toEqual([[scope.sessionKey]]);
      } finally {
        projection.dispose();
        release();
      }
    },
  );
});

import { DatabaseSync } from "node:sqlite";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getAcpSessionManager, testing as managerTesting } from "../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntryAsync,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAcpTaskBackingDetail } from "./task-backing-records.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import {
  cleanupTerminalAcpSession,
  loadTaskAcpSessionCloser,
} from "./task-registry-acp-cleanup.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

function updateForeignSessionEntry(
  storePath: string,
  sessionKey: string,
  field: keyof Pick<SessionEntry, "spawnedBy" | "parentSessionKey" | "lifecycleRevision">,
  value: string,
) {
  const foreign = new DatabaseSync(storePath);
  try {
    foreign.exec("BEGIN IMMEDIATE");
    try {
      const changed = foreign
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
        )
        .run(`$.${field}`, value, sessionKey);
      expect(changed.changes).toBe(1);
      // The entry trigger clears certification; update lineage and certify only after it runs.
      foreign
        .prepare(
          `UPDATE session_nodes
           SET parent_session_key = coalesce(json_extract(entry_json, '$.parentSessionKey'),
                                             json_extract(entry_json, '$.spawnedBy')),
               spawned_by = json_extract(entry_json, '$.spawnedBy'),
               entry_valid = 1
           WHERE session_key = ?`,
        )
        .run(sessionKey);
      foreign.exec("COMMIT");
    } catch (error) {
      foreign.exec("ROLLBACK");
      throw error;
    }
  } finally {
    foreign.close();
  }
}

const backendId = "task-cleanup-proof";
afterEach(() => {
  vi.restoreAllMocks();
  unregisterAcpRuntimeBackend(backendId);
  managerTesting.resetAcpSessionManagerForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it.each([
  { boundary: "unchanged", change: "none" },
  { boundary: "runtime preparation", change: "task" },
  { boundary: "runtime close", change: "task" },
  { boundary: "runtime preparation", change: "owner" },
  { boundary: "runtime preparation", change: "owner and runtime identity" },
  { boundary: "runtime close", change: "lifecycle" },
  { boundary: "recoverable runtime close", change: "owner" },
  { boundary: "recoverable runtime close", change: "lifecycle" },
  { boundary: "recoverable runtime close", change: "none" },
  { boundary: "runtime preparation", change: "navigation parent" },
] as const)(
  "keeps ACP cleanup bound across $change changes at $boundary without host data SQL",
  async ({ boundary, change }) => {
    await withOpenClawTestState({ label: "task-acp-cleanup-sqlite" }, async (state) => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const sessionKey = "agent:main:acp:cleanup";
      const ownerKey = "agent:main:main";
      const storePath = state.path("sessions.sqlite");
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {} } },
        acp: { enabled: true, backend: backendId },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      const originalEntry = await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey, env: state.env },
        {
          sessionId: "original",
          lifecycleRevision: "original-lifecycle",
          updatedAt: 1,
          spawnedBy: ownerKey,
        },
      );
      expect(originalEntry).not.toBeNull();
      const meta: SessionAcpMeta = {
        backend: backendId,
        agent: "main",
        runtimeSessionName: "cleanup-runtime",
        mode: "oneshot",
        state: "idle",
        lastActivityAt: 1,
      };
      writeAcpSessionMetaForMigration({
        env: state.env,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, "main"),
        lifecycleRevision: originalEntry!.lifecycleRevision,
        meta,
      });
      using deliveries = captureTaskDeliveryWork();
      const terminal = createTaskFixture("acp", {
        ownerKey,
        requesterSessionKey: ownerKey,
        childSessionKey: sessionKey,
        agentId: "main",
        runId: "original",
        status: "succeeded",
        task: "Completed ACP task",
        notifyPolicy: "silent",
        detail: createAcpTaskBackingDetail("original", 1),
      });
      await deliveries.settle();
      const store = await prepareTaskFixtureRead(terminal);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const hold = async () => {
        entered.resolve();
        await resume.promise;
      };
      const close = vi.fn<AcpRuntime["close"]>(async () => {
        if (boundary === "runtime close" || boundary === "recoverable runtime close") {
          await hold();
        }
        if (boundary === "recoverable runtime close") {
          throw new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            "Backend session needs a fresh reset",
          );
        }
      });
      const prepareFresh = vi.fn(async () => {});
      const runtime: AcpRuntime = {
        ensureSession: async () => {
          if (boundary === "runtime preparation") {
            await hold();
          }
          const changedIdentity =
            boundary === "runtime preparation" &&
            (change === "task" || change === "owner and runtime identity");
          return {
            sessionKey,
            backend: backendId,
            runtimeSessionName: changedIdentity ? "new-runtime" : meta.runtimeSessionName,
            ...(changedIdentity ? { backendSessionId: "new-backend-session" } : {}),
          };
        },
        async *runTurn() {
          yield { type: "done" };
        },
        cancel: async () => {},
        prepareFreshSession: prepareFresh,
        close,
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const manager = getAcpSessionManager();
      const closer = await loadTaskAcpSessionCloser();
      const taskRead = await prepareTaskRegistryRead();
      expect(taskRead).toBeDefined();
      const unbind = vi.fn().mockResolvedValue([]);
      const mutationEntered = createDeferredCore();
      const persist = createDeferredCore();
      const mutate = store.runInitialMutationAsync.bind(store);
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        if (args[1].type === "tasks.createRecord") {
          mutationEntered.resolve();
          await persist.promise;
        }
        return mutate(...args);
      });
      const sql = observeHostDataSql(state.env);
      let successor: ReturnType<typeof createRunningTaskRunCoreWithReceiptAsync> | undefined;
      const cleanup = cleanupTerminalAcpSession(
        {
          listAcpSessionEntries,
          readAcpSessionEntryAsync,
          prepareTaskRegistryRead,
          listSessionBindingsBySession: () => [],
          unbindSessionBindings: unbind,
        },
        terminal,
        closer,
        () => taskRead!.assertOwnerCurrent(),
      );
      try {
        if (boundary !== "unchanged") {
          await Promise.race([
            entered.promise,
            cleanup.then(() => {
              throw new Error("Cleanup finished before reaching the runtime boundary");
            }),
          ]);
          if (change === "task") {
            successor = createRunningTaskRunCoreWithReceiptAsync({
              runtime: "acp",
              scopeKind: "session",
              ownerKey,
              requesterSessionKey: ownerKey,
              childSessionKey: sessionKey,
              agentId: "main",
              runId: "successor",
              task: "Successor ACP task",
              notifyPolicy: "silent",
              deliveryStatus: "not_applicable",
              detail: createAcpTaskBackingDetail("successor", 2),
            });
            await Promise.race([
              mutationEntered.promise,
              successor.then(() => {
                throw new Error("Successor finished before the persistence hold");
              }),
            ]);
          } else if (change !== "none") {
            // A foreign writer publishes no session event; the close/read owners must observe it.
            expect(sql.queries).toEqual([]);
            const field =
              change === "owner" || change === "owner and runtime identity"
                ? "spawnedBy"
                : change === "lifecycle"
                  ? "lifecycleRevision"
                  : "parentSessionKey";
            const value = change === "lifecycle" ? "replacement-lifecycle" : "agent:main:other";
            updateForeignSessionEntry(storePath, sessionKey, field, value);
            // Exclude only the synchronous fixture transaction while the runtime is held.
            sql.queries.length = 0;
            const changed = await readAcpSessionEntryAsync({ cfg, agentId: "main", sessionKey });
            expect(changed?.storeReadFailed).not.toBe(true);
            expect(changed?.entry).toMatchObject({ sessionId: "original", [field]: value });
            expect(changed?.acp).toEqual(change === "lifecycle" ? undefined : meta);
          }
          resume.resolve();
        }
        await cleanup;
        const eligible = change === "none" || change === "navigation parent";
        expect(
          close.mock.calls.filter(([input]) => input.reason === "terminal-task-cleanup"),
        ).toHaveLength(boundary === "runtime preparation" && !eligible ? 0 : 1);
        expect(prepareFresh).toHaveBeenCalledTimes(
          boundary === "recoverable runtime close" && eligible ? 1 : 0,
        );
        if (boundary === "runtime preparation" && !eligible) {
          expect(close).not.toHaveBeenCalled();
          expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
        }
        expect(unbind).toHaveBeenCalledTimes(eligible ? 1 : 0);
        let current = await readAcpSessionEntryAsync({ cfg, agentId: "main", sessionKey });
        if (change === "lifecycle") {
          expect(current?.entry?.lifecycleRevision).toBe("replacement-lifecycle");
          expect(sql.queries).toEqual([]);
          // Restore only the fixture's foreign fence to inspect whether cleanup deleted its metadata.
          updateForeignSessionEntry(
            storePath,
            sessionKey,
            "lifecycleRevision",
            originalEntry!.lifecycleRevision!,
          );
          sql.queries.length = 0;
          current = await readAcpSessionEntryAsync({ cfg, agentId: "main", sessionKey });
        }
        expect(current?.acp).toEqual(eligible ? undefined : meta);
        expect(current?.entry?.sessionId).toBe("original");
        expect(current?.entry?.spawnedBy).toBe(
          change === "owner" || change === "owner and runtime identity"
            ? "agent:main:other"
            : ownerKey,
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        resume.resolve();
        persist.resolve();
        await Promise.allSettled([cleanup, successor]);
        await deliveries.settle();
        await disposeAcpSessionManagerInstance(manager, "fixture-cleanup");
      }
    });
  },
);

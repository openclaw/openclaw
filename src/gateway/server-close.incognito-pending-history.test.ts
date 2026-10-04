import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionPendingInputPage } from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
} from "./server-close.test-support.js";
import { createIncognitoSessionHistoryReader } from "./session-history-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const order: string[] = [];
let actor: IncognitoAgentDatabaseExecution;

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes: async () => {},
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
});
const createGatewayCloseHandler = createGatewayCloseTestHandlerFactory({
  prepareGatewayClose,
  completeGatewayClose,
});

beforeAll(async () => {
  const open = workerStore.openEphemeralAgentDatabaseSqliteWorkerStore;
  const opening = vi
    .spyOn(workerStore, "openEphemeralAgentDatabaseSqliteWorkerStore")
    .mockImplementation(async (options, custody) => {
      const store = await open(
        {
          ...options,
          moduleUrl: new URL(
            "../state/openclaw-agent-execution-incognito.pending-fixture.test-support.ts",
            import.meta.url,
          ),
        },
        custody,
      );
      assert(store);
      const close = store.close.bind(store);
      vi.spyOn(store, "close").mockImplementation(async () => {
        order.push("transport-close");
        await close();
      });
      return store;
    });
  try {
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("gateway-close-incognito-pending-") },
      authority,
    });
    assert(opened);
    actor = opened;
  } finally {
    opening.mockRestore();
  }
});

afterAll(async () => {
  try {
    await actor?.close();
    await closeOpenClawStateDatabaseAsync();
  } finally {
    vi.restoreAllMocks();
  }
});

it("drains an accepted interruption after scheduler abort before closing the actor transport", async () => {
  const target = {
    sessionKey: "agent:main:dashboard:incognito-pending-close",
    sessionId: "pending-close",
    lifecycleRevision: "initial",
  };
  await actor.sessions.read(authority, { sessionKey: target.sessionKey });
  const history = createIncognitoSessionHistoryReader({
    actor,
    authority,
    target: { ...target, agentId: actor.agentId, storePath: actor.path },
    subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
    resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" }),
  });
  const queued = createDeferredCore();
  const resume = createDeferredCore();
  const result = createDeferredCore<SessionPendingInputPage>();
  const schedulerClosing = createDeferredCore();
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const run = workerStore.runSqliteWorkerStoreOperation;
  const dispatch = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof run>[2],
        assertCurrent?: Parameters<typeof run>[3],
        createAdmission?: Parameters<typeof run>[4],
      ) =>
        run(
          store,
          (scope) =>
            operation({
              execute: async (command, options) => {
                if (command.type === "session.pendingInputs.interruptHistory") {
                  queued.resolve();
                  await resume.promise;
                }
                return scope.execute(command, options);
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission,
        ),
    );
  scheduler.schedule({
    id: "incognito-pending-history-close-proof",
    delayMs: 0,
    async run() {
      try {
        const page = await history.listPendingInputs();
        order.push("interruption-settled");
        result.resolve(page);
      } catch (error) {
        result.reject(error);
      }
    },
  });
  const scheduled = Promise.resolve(clock.wake());
  const outcome = result.promise;
  void outcome.catch(() => {});
  let closing: Promise<unknown> | undefined;
  try {
    await awaitGateBeforeSettlement(
      queued.promise,
      outcome,
      "Pending history settled before its interruption was accepted",
    );
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: [],
        async stopScheduler() {
          const stopping = scheduler.stop();
          order.push("scheduler-aborted");
          schedulerClosing.resolve();
          await stopping;
          order.push("scheduler-drained");
        },
      }),
    );
    closing = close({ reason: "incognito pending-history close proof", drainTimeoutMs: 0 });
    await awaitGateBeforeSettlement(
      schedulerClosing.promise,
      closing,
      "Gateway close skipped the scheduler drain",
    );
    expect(scheduler.signal.aborted).toBe(true);
    expect(order).toEqual(["scheduler-aborted"]);
    resume.resolve();
    await expect(outcome).resolves.toMatchObject({
      items: [
        { id: "close-first", state: "interrupted" },
        { id: "close-second", state: "interrupted" },
      ],
    });
    await expect(closing).resolves.toMatchObject({ warnings: [] });
    expect(order).toEqual([
      "scheduler-aborted",
      "interruption-settled",
      "scheduler-drained",
      "transport-close",
    ]);
  } finally {
    resume.resolve();
    await Promise.allSettled([scheduled, outcome, closing, scheduler.stop()]);
    dispatch.mockRestore();
  }
});

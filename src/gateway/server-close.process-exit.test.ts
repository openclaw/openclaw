import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { readOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";
import * as lifecyclePersistence from "./session-lifecycle-persistence-owner.js";

it("keeps accepted terminal writes and the clean-close receipt ahead of process exit", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  const scheduler = createTestGatewayScheduler();
  const terminalOwner = lifecyclePersistence.createSessionLifecyclePersistenceOwner(scheduler);
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const terminalDraining = createDeferredCore();
  const terminalDrained = createDeferredCore();
  const releaseMemory = createDeferredCore();
  const exitEntered = createDeferredCore();
  const releaseExit = createDeferredCore();
  const onProcessExitReady = vi.fn(async () => {
    exitEntered.resolve();
    await releaseExit.promise;
  });
  const createDeps = createGatewayCloseTestDepsFactory({
    disposeAllBundleLspRuntimes: async () => {},
    stopGmailWatcher: async () => {},
    disposeAllCodeModeRuns: async () => {},
    closeProviderTransportDispatcherPool: async () => {},
    drainRetainedEmbeddingProviders: async () => {},
  });
  const params = createDeps({
    drainPersistence: async () => {
      terminalDraining.resolve();
      await terminalOwner.drain();
      terminalDrained.resolve();
    },
    preparePluginRegistryClose: async () => {
      await releaseMemory.promise;
      return [];
    },
  });
  let heldWriter: ReturnType<typeof patchSessionEntryCore> | undefined;
  let terminalWrite: Promise<void> | undefined;
  let boardWrite: ReturnType<SqliteBoardStore["putWidget"]> | undefined;
  let closing: Promise<unknown> | undefined;
  try {
    const options = { agentId: "main", env: state.env };
    const sessionKey = "agent:main:process-exit";
    const event = {
      runId: "process-exit-run",
      sessionId: "process-exit-session",
      seq: 1,
      stream: "lifecycle",
      ts: 2_000,
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    };
    const target = { agentId: "main", sessionKey };
    await replaceSessionEntry(target, {
      sessionId: event.sessionId,
      lifecycleRunId: event.runId,
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    const agent = openOpenClawAgentDatabase(options);
    heldWriter = patchSessionEntryCore(
      target,
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        return { label: "accepted before shutdown" };
      },
      { skipMaintenance: true },
    );
    await withinTest(writerEntered.promise, signal);
    const boards = new SqliteBoardStore({
      env: state.env,
      resolveSession: () => ({ agentId: "main", path: agent.path, sessionKey }),
    });
    boardWrite = boards.putWidget({
      sessionKey,
      name: "accepted",
      content: { kind: "html", html: "<p>Accepted before close</p>" },
    });
    void boardWrite.catch(() => {});
    terminalWrite = terminalOwner.observe({ ...target, event });
    closing = prepareGatewayClose(params, {
      reason: "gateway restarting",
      restartExpectedMs: 1_500,
      drainTimeoutMs: 0,
      onProcessExitReady,
    }).then((preparation) => completeGatewayClose(params, preparation));
    await withinTest(
      awaitGateBeforeSettlement(
        terminalDraining.promise,
        closing,
        "Gateway skipped accepted terminal persistence before exit",
      ),
      signal,
    );
    expect(onProcessExitReady).not.toHaveBeenCalled();
    expect(agent.db.isOpen).toBe(true);
    releaseWriter.resolve();
    await withinTest(
      Promise.all([heldWriter, boardWrite, terminalWrite, terminalDrained.promise]),
      signal,
    );
    expect(await boardWrite).toMatchObject({
      resolvedWidgetName: "accepted",
      widgets: [{ name: "accepted" }],
    });
    expect(onProcessExitReady).not.toHaveBeenCalled();
    expect(agent.db.isOpen).toBe(true);
    releaseMemory.resolve();
    await withinTest(
      awaitGateBeforeSettlement(exitEntered.promise, closing, "Gateway skipped process exit"),
      signal,
    );
    expect(agent.db.isOpen).toBe(false);
    expect(readOpenClawAgentIntegrityVerification(agent.path, state.env)?.clean_close).toBe(1);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    expect(() => openOpenClawAgentDatabase(options)).toThrow(
      "Agent database resources are closing",
    );
    expect(params.stopChannel).not.toHaveBeenCalled();
    expect(params.stopScheduler).not.toHaveBeenCalled();
    releaseExit.resolve();
    await withinTest(closing, signal);
    expect(loadSessionEntry(target)).toMatchObject({
      label: "accepted before shutdown",
      status: "done",
      startedAt: 1_000,
      endedAt: 2_000,
    });
  } finally {
    releaseWriter.resolve();
    releaseMemory.resolve();
    releaseExit.resolve();
    await Promise.allSettled([heldWriter, boardWrite, terminalWrite, closing]);
    await scheduler.stop();
    await state.cleanup();
  }
});

import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../agents/run-termination.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  hasLiveAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import { registerQueuedChatTurn, type QueuedChatTurnMap } from "./chat-queued-turns.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { prepareGatewayRunShutdown } from "./server-run-shutdown.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import {
  createSubscriptionTestFixture,
  registerSubscriptionChatRun,
} from "./server-runtime-subscriptions.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const cfg = { agents: { entries: { main: {} } } };
let state: OpenClawTestState;
let storePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "restart-drain-session-settlement" });
  setRuntimeConfigSnapshot(cfg, cfg);
  storePath = state.statePath("agents", "main", "sessions", "sessions.json");
});

afterAll(async () => {
  rotateAgentEventLifecycleGeneration();
  await state?.cleanup();
});

it.each([
  "before planning",
  "before commit",
  "user abort",
  "replacement",
  "newer run",
  "reset",
  "non-main",
  "completed",
] as const)("revalidates collected shutdown recovery custody after %s", async (releaseAt) => {
  const sessionKey = `agent:main:dashboard:released-${releaseAt}`;
  const sessionId = `released-${releaseAt}`;
  const runId = `${sessionId}-run`;
  const target = { storePath, sessionKey };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1, lifecycleRunId: runId });
  const resolveGatewayContext = () => undefined;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    resolveGatewayContext,
    assertAllowed: () => {},
  });
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionKey,
    sessionId,
    timeoutMs: 60_000,
  });
  const shouldMark = releaseAt === "before planning" || releaseAt === "before commit";
  if (releaseAt !== "user abort") {
    registration.controller.abort(createAgentRunRestartAbortError());
  }
  const release = () => {
    registration.cleanup();
    admission.release();
    expect(chatAbortControllers.has(runId)).toBe(false);
    expect(admission.isActive()).toBe(false);
  };
  const apply = sessionAccessor.applySessionEntryReplacements;
  const replacementSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");
  if (releaseAt === "before commit") {
    replacementSpy.mockImplementationOnce((params) =>
      apply({
        ...params,
        update: async (entries) => {
          const prepared = await params.update(entries);
          release();
          return prepared;
        },
      }),
    );
  }
  const harness = createAgentEventTestHarness();
  let replacement: ReturnType<typeof registerChatAbortController> | undefined;
  try {
    await prepareGatewayRunShutdown({
      resolveGatewayContext,
      restart: true,
      timeoutMs: 0,
      warnings: [],
      getPendingReplyCount: () => 0,
      chatAbortControllers,
      chatQueuedTurns: new Map(),
      chatRunState: harness.chatRunState,
      agentRunSeq: harness.agentRunSeq,
      removeChatRun: () => undefined,
      broadcast: harness.broadcast,
      nodeSendToSession: harness.nodeSendToSession,
      markMainSessionsAbortedForRestart: async (params) => {
        if (releaseAt === "user abort") {
          registration.controller.abort(createAgentRunDirectAbortError());
        }
        if (releaseAt === "completed" && registration.registered) {
          registration.entry.projectSessionTerminalPersisted = true;
        }
        if (releaseAt !== "before commit") {
          release();
        }
        if (releaseAt === "replacement" || releaseAt === "newer run") {
          replacement = registerChatAbortController({
            chatAbortControllers,
            runId: releaseAt === "newer run" ? "newer-run" : runId,
            sessionKey,
            sessionId,
            timeoutMs: 60_000,
          });
        }
        if (releaseAt === "newer run" || releaseAt === "reset" || releaseAt === "non-main") {
          await replaceSessionEntry(target, {
            sessionId: releaseAt === "reset" ? "reset-session" : sessionId,
            lifecycleRunId: releaseAt === "newer run" ? "newer-run" : runId,
            restartRecoveryDeliveryRunId: runId,
            updatedAt: Date.now(),
            ...(releaseAt === "non-main" ? { spawnDepth: 1 } : {}),
          });
        }
        await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
      },
    });
    const saved = loadSessionEntry(target);
    if (shouldMark) {
      expect(saved).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: expect.any(String) },
        restartRecoveryRuns: [{ runId, lifecycleGeneration: getAgentEventLifecycleGeneration() }],
      });
    } else {
      expect(saved?.mainRestartRecovery).toBeUndefined();
      expect(saved?.abortedLastRun).not.toBe(true);
    }
  } finally {
    replacementSpy.mockRestore();
    registration.cleanup();
    replacement?.cleanup();
    admission.release();
    await harness.handler.dispose();
  }
});

it.each(["admission", "queue", "delegated"] as const)(
  "retains %s work through shutdown and gives it one explicit recovery outcome",
  async (kind) => {
    const sessionKey = `agent:main:dashboard:restart-${kind}`;
    const sessionId = `restart-${kind}-session`;
    const runId = `restart-${kind}-run`;
    const target = { storePath, sessionKey };
    const resolveGatewayContext = () => undefined;
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
      restartRecoverySourceIngress: kind === "delegated" ? "internal" : "control-ui",
    });
    await appendTranscriptMessage(
      { ...target, sessionId },
      {
        message: {
          role: "user",
          content: "Finish the synthetic task after restart.",
          idempotencyKey: runId,
          ...(kind === "delegated" ? { provenance: { kind: "inter_session" } } : {}),
        },
      },
    );
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext,
      assertAllowed: () => {},
    });
    const chatQueuedTurns: QueuedChatTurnMap = new Map();
    const controller = new AbortController();
    const reply =
      kind === "queue"
        ? createReplyOperation({ sessionKey, sessionId, resetTriggered: false })
        : undefined;
    let queueCancelledBeforeReply = false;
    if (reply) {
      bindGatewayContextResolver(reply, resolveGatewayContext);
      reply.abortSignal.addEventListener("abort", () => {
        queueCancelledBeforeReply = controller.signal.aborted;
      });
    }
    if (kind === "queue") {
      expect(
        registerQueuedChatTurn({
          chatQueuedTurns,
          controller,
          runId,
          sessionKey,
          sessionId,
          onAborted: () => admission.release(),
        }),
      ).toBe(true);
    }
    const gatewayRuntime = createMockGatewayRecoveryRuntime();
    vi.mocked(gatewayRuntime.dispatchAgent).mockResolvedValue({
      runId: "resumed-run",
      status: "ok",
    });
    const recoveryLog = vi.spyOn(mainSessionRecoveryLog, "info");
    try {
      const harness = createAgentEventTestHarness();
      await prepareGatewayRunShutdown({
        resolveGatewayContext,
        restart: true,
        timeoutMs: 0,
        warnings: [],
        getPendingReplyCount: () => 0,
        chatAbortControllers: new Map(),
        chatQueuedTurns,
        chatRunState: harness.chatRunState,
        agentRunSeq: harness.agentRunSeq,
        removeChatRun: () => undefined,
        broadcast: harness.broadcast,
        nodeSendToSession: harness.nodeSendToSession,
        markMainSessionsAbortedForRestart: async (params) => {
          await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
        },
      });
      expect(loadSessionEntry(target)).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: expect.any(String) },
      });
      if (kind === "queue") {
        expect(controller.signal.reason).toMatchObject({ code: "OPENCLAW_RESTART_ABORT" });
        expect(chatQueuedTurns.size).toBe(0);
        expect(admission.isActive()).toBe(false);
        expect(queueCancelledBeforeReply).toBe(true);
      }
      reply?.complete();
      admission.release();
      rotateAgentEventLifecycleGeneration();
      const recover = () =>
        recoverStore({
          cfg,
          storePath,
          stateDir: state.stateDir,
          expectedTarget: { sessionKey, sessionId },
          handledSessionKeys: new Set(),
          gatewayRuntime,
        });
      await recover();
      await recover();
      if (kind === "delegated") {
        expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toMatchObject({
          status: "failed",
          abortedLastRun: false,
          mainRestartRecovery: {
            tombstone: { reason: "delegated recovery sender authority is unavailable" },
          },
        });
        const transcript = JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }));
        expect(transcript).toContain("delegated recovery sender authority is unavailable");
        expect(transcript.match(/Resume in new session/g)).toHaveLength(1);
        expect(recoveryLog).toHaveBeenCalledWith(
          expect.stringContaining('"reason":"delegated_authority_unavailable"'),
        );
      } else {
        expect(gatewayRuntime.dispatchAgent).toHaveBeenCalledTimes(1);
        expect(loadSessionEntry(target)).toMatchObject({ status: "done", abortedLastRun: false });
      }
    } finally {
      reply?.complete();
      admission.release();
      recoveryLog.mockRestore();
    }
  },
);

it.each(
  [true, false].flatMap((restart) =>
    ["none", "active", "pending"].map((callbackFailure) => ({ restart, callbackFailure })),
  ),
)(
  "interrupts non-chat Gateway admission owners while preserving final writes (restart=$restart, callbackFailure=$callbackFailure)",
  async ({ restart, callbackFailure }) => {
    const sessionKey = `agent:main:dashboard:owned-shutdown-${restart}`;
    const sessionId = `owned-shutdown-${restart}`;
    const target = { storePath, sessionKey };
    const resolveGatewayContext = () => undefined;
    const owner = Symbol(sessionKey);
    const controller = new AbortController();
    const pendingController = new AbortController();
    const interrupted = createDeferred();
    const taskStarted = createDeferred();
    const persistFinalWrite = createDeferred();
    const finalSessionKey = `${sessionKey}-final`;
    const finalSessionId = `${sessionId}-final`;
    const finalTarget = { storePath, sessionKey: finalSessionKey, sessionId: finalSessionId };
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1,
      restartRecoveryDeliveryRunId: `${sessionId}-run`,
      restartRecoverySourceIngress: "control-ui",
    });
    await appendTranscriptMessage(
      { ...target, sessionId },
      { message: { role: "user", content: "Resume this synthetic work after restart." } },
    );
    await replaceSessionEntry(finalTarget, {
      sessionId: finalSessionId,
      updatedAt: 1,
      status: "done",
    });
    let recoveryMarkedBeforeInterruption = false;
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      owner,
      resolveGatewayContext,
      onInterrupt: (reason) => {
        recoveryMarkedBeforeInterruption = Boolean(loadSessionEntry(target)?.mainRestartRecovery);
        controller.abort(reason);
        interrupted.resolve();
        if (callbackFailure === "active") {
          throw new Error("Synthetic active admission cancellation failure");
        }
      },
    });
    const pendingValidation = vi.fn();
    let pendingPromoted = false;
    const pending = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      owner,
      serializeOwner: true,
      resolveGatewayContext,
      assertAllowed: pendingValidation,
      onInterrupt: (reason) => {
        pendingController.abort(reason);
        if (callbackFailure === "pending") {
          throw new Error("Synthetic pending admission cancellation failure");
        }
      },
    }).then(
      (lease) => {
        pendingPromoted = true;
        lease.release();
        return undefined;
      },
      (error: unknown) => error,
    );
    const interruptFinalWrite = vi.fn();
    const finalAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [finalSessionKey, finalSessionId],
      resolveGatewayContext,
      isSettling: () => true,
      onInterrupt: interruptFinalWrite,
    });
    const finalWrite = finalAdmission
      .run(async () => {
        await persistFinalWrite.promise;
        await appendTranscriptMessage(finalTarget, {
          message: { role: "assistant", content: "The protected final write persisted." },
        });
      })
      .finally(() => finalAdmission.release());
    const siblingInterrupt = vi.fn();
    const unboundInterrupt = vi.fn();
    const sibling = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext: () => undefined,
      onInterrupt: siblingInterrupt,
    });
    const unbound = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext: undefined,
      onInterrupt: unboundInterrupt,
    });
    const lane = `session:${sessionKey}`;
    const active = admission
      .run(() =>
        enqueueCommandInLane(
          lane,
          async () => {
            taskStarted.resolve();
            try {
              await interrupted.promise;
              controller.signal.throwIfAborted();
            } finally {
              admission.release();
            }
          },
          { abortSignal: controller.signal },
        ),
      )
      .catch((error: unknown) => error);
    await taskStarted.promise;
    const queuedTask = vi.fn(async () => undefined);
    const queued = enqueueCommandInLane(lane, queuedTask, {
      abortSignal: controller.signal,
    }).catch((error: unknown) => error);
    const harness = createAgentEventTestHarness();
    try {
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      expect(pendingValidation).not.toHaveBeenCalled();
      const shutdown = await prepareGatewayRunShutdown({
        resolveGatewayContext,
        restart,
        timeoutMs: 0,
        warnings: [],
        getPendingReplyCount: () => 0,
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: harness.chatRunState,
        agentRunSeq: harness.agentRunSeq,
        removeChatRun: () => undefined,
        broadcast: harness.broadcast,
        nodeSendToSession: harness.nodeSendToSession,
        markMainSessionsAbortedForRestart: async (params) => {
          await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
        },
      });
      expect(controller.signal.aborted).toBe(true);
      expect(pendingController.signal.aborted).toBe(true);
      expect(recoveryMarkedBeforeInterruption).toBe(restart);
      const [activeError, queuedError, pendingError] = await Promise.all([active, queued, pending]);
      for (const error of [activeError, queuedError, pendingError]) {
        expect(error).toBeInstanceOf(Error);
        if (restart) {
          expect(error).toMatchObject({ code: "OPENCLAW_RESTART_ABORT" });
        }
      }
      expect(pendingPromoted).toBe(false);
      expect(pendingValidation).not.toHaveBeenCalled();
      expect(queuedTask).not.toHaveBeenCalled();
      expect(admission.isActive()).toBe(false);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
      expect(finalAdmission.isActive()).toBe(true);
      expect(interruptFinalWrite).not.toHaveBeenCalled();
      expect(sibling.isActive()).toBe(true);
      expect(unbound.isActive()).toBe(true);
      expect(siblingInterrupt).not.toHaveBeenCalled();
      expect(unboundInterrupt).not.toHaveBeenCalled();
      let released = false;
      void shutdown.released.then(
        () => {
          released = true;
        },
        () => {
          released = true;
        },
      );
      await Promise.resolve();
      expect(released).toBe(false);
      persistFinalWrite.resolve();
      await finalWrite;
      if (callbackFailure === "none") {
        await shutdown.released;
      } else {
        await expect(shutdown.released).rejects.toThrow(
          `Synthetic ${callbackFailure} admission cancellation failure`,
        );
      }
      expect(finalAdmission.isActive()).toBe(false);
      expect(JSON.stringify(await loadTranscriptEvents(finalTarget))).toContain(
        "The protected final write persisted.",
      );
    } finally {
      controller.abort(createAgentRunRestartAbortError());
      interrupted.resolve();
      persistFinalWrite.resolve();
      await Promise.all([active, queued, finalWrite]);
      admission.release();
      await pending;
      sibling.release();
      unbound.release();
      await harness.handler.dispose();
    }
  },
);

it.each(
  (
    [
      "interrupted",
      "retired while persisting",
      "completed",
      "completed while retired",
      "replacement",
    ] as const
  ).flatMap((outcome) => [
    { outcome, aliased: false },
    { outcome, aliased: true },
  ]),
)(
  "retains only interrupted terminal custody before shutdown marking: $outcome, aliased=$aliased",
  async ({ outcome, aliased }) => {
    const completed = outcome === "completed" || outcome === "completed while retired";
    const retireWhilePersisting =
      outcome === "retired while persisting" || outcome === "completed while retired";
    const sessionKey = `agent:main:dashboard:persisted-terminal-${outcome}-${aliased}`;
    const sessionId = `persisted-terminal-${outcome}-${aliased}`;
    const runId = `${sessionId}-run`;
    const clientRunId = aliased ? `${runId}-client` : runId;
    const target = { storePath, sessionKey };
    const subscriptionConfig = { ...cfg, logging: { audit: { enabled: false } } };
    setRuntimeConfigSnapshot(subscriptionConfig, subscriptionConfig);
    await replaceSessionEntry(target, { sessionId, updatedAt: 1, lifecycleRunId: runId });
    const params = createSubscriptionTestFixture().createParams();
    const clock = createGatewaySchedulerClock(Date.now());
    params.scheduler = createTestGatewayScheduler(clock.clock);
    params.chatRunState.registry.add(runId, { sessionKey, clientRunId });
    const registration = registerSubscriptionChatRun(params, {
      runId: clientRunId,
      sessionKey,
      sessionId,
      agentId: "main",
    });
    registration.markExecutionStarted();
    registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
    const unsubs = startGatewayEventSubscriptions(params);
    let unsubscribeAgent: Promise<void> | undefined;
    const drain = () => (unsubscribeAgent ??= unsubs.agentUnsub());
    let replacement: ReturnType<typeof registerSubscriptionChatRun> | undefined;
    const replacementRunId = `${runId}-replacement`;
    const writeEntered = createDeferred();
    const releaseWrite = createDeferred();
    const patch = sessionAccessor.patchSessionEntryTarget;
    const heldWrite = retireWhilePersisting
      ? vi
          .spyOn(sessionAccessor, "patchSessionEntryTarget")
          .mockImplementationOnce(async (...args) => {
            writeEntered.resolve();
            await releaseWrite.promise;
            return patch(...args);
          })
      : undefined;
    try {
      if (!completed) {
        registration.controller.abort(createAgentRunRestartAbortError());
      }
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        agentId: "main",
        stream: "lifecycle",
        data: {
          phase: "end",
          ...(!completed ? { aborted: true, stopReason: "restart" } : {}),
        },
      });
      registration.cleanup();
      if (heldWrite) {
        await writeEntered.promise;
        registration.entry.expiresAtMs = clock.clock.now() - 1;
        const timers = startGatewayMaintenanceTimers({
          ...createGatewayMaintenanceStateForTest(),
          ...params,
        });
        try {
          await clock.advanceBy(60_000);
          expect(params.chatAbortControllers.has(clientRunId)).toBe(false);
          expect(params.restartRecoveryCandidates.get(clientRunId)).toMatchObject({
            runId: clientRunId,
            ...(aliased ? { sourceRunId: runId } : {}),
          });
        } finally {
          await timers.stopPeriodicTasks();
          await timers.skillUsageCleanup();
        }
        releaseWrite.resolve();
      }
      await waitForChatAbortTerminalPersistence(registration.entry);
      expect(params.chatAbortControllers.has(clientRunId)).toBe(false);
      expect(loadSessionEntry(target)).toMatchObject({
        status: completed ? "done" : "interrupted",
        abortedLastRun: !completed,
        lastRunId: clientRunId,
      });

      await prepareGatewayRunShutdown({
        ...params,
        resolveGatewayContext: () => undefined,
        restart: true,
        timeoutMs: 0,
        warnings: [],
        getPendingReplyCount: () => 0,
        chatQueuedTurns: new Map(),
        removeChatRun: () => undefined,
        markMainSessionsAbortedForRestart: async (captured) => {
          if (outcome === "replacement") {
            // The old terminal is already durable; a newer turn wins before its marker writes.
            replacement = registerSubscriptionChatRun(params, {
              runId: replacementRunId,
              sessionKey,
              sessionId,
              agentId: "main",
            });
            replacement.markExecutionStarted();
            registerAgentRunContext(replacementRunId, {
              sessionKey,
              sessionId,
              agentId: "main",
            });
            emitAgentEvent({
              runId: replacementRunId,
              sessionKey,
              sessionId,
              agentId: "main",
              stream: "lifecycle",
              data: { phase: "start", startedAt: Date.now() },
            });
          }
          await drain();
          await markRestartAbortedMainSessions({ ...captured, cfg, stateDir: state.stateDir });
        },
      });
      const saved = loadSessionEntry(target);
      if (outcome === "interrupted" || outcome === "retired while persisting") {
        expect(saved).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          mainRestartRecovery: { cycleId: expect.any(String), revision: expect.any(Number) },
        });
        expect(saved?.restartRecoveryRuns).toEqual([
          { runId, lifecycleGeneration: getAgentEventLifecycleGeneration() },
          ...(aliased
            ? [{ runId: clientRunId, lifecycleGeneration: getAgentEventLifecycleGeneration() }]
            : []),
        ]);
      } else {
        expect(saved?.mainRestartRecovery).toBeUndefined();
        if (completed) {
          expect(params.restartRecoveryCandidates.has(clientRunId)).toBe(false);
          expect(saved).toMatchObject({
            status: "done",
            abortedLastRun: false,
            lastRunId: clientRunId,
          });
        } else {
          expect(saved?.lifecycleRunId).toBe(replacementRunId);
        }
      }
    } finally {
      releaseWrite.resolve();
      await drain();
      heldWrite?.mockRestore();
      unsubs.heartbeatUnsub();
      unsubs.transcriptUnsub();
      unsubs.lifecycleUnsub();
      registration.cleanup();
      replacement?.cleanup();
      clearAgentRunContext(runId);
      clearAgentRunContext(replacementRunId);
      setRuntimeConfigSnapshot(cfg, cfg);
    }
  },
);

it("persists recovery when restart cancellation precedes shutdown marking", async () => {
  const childKey = "agent:main:dashboard:child";
  const mainKey = "agent:main:dashboard:main";
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const persist = vi.fn(persistGatewaySessionLifecycleEvent);
  const harness = createAgentEventTestHarness({
    persistGatewaySessionLifecycleEventForEvent: persist,
  });
  harness.clearAgentRunContext.mockImplementation(clearAgentRunContext);
  const unsubscribe = subscribeAgentEvents(harness.handler);
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const joinPersistence = async () => {
    await unsubscribe.drain();
    await Promise.all(persist.mock.results.map((result) => result.value));
  };
  const read = (sessionKey: string) =>
    expectDefined(
      loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
      "persisted session",
    );
  try {
    for (const [sessionKey, spawnDepth] of [
      [childKey, 1],
      [mainKey, 0],
    ] as const) {
      const runId = `${sessionKey}:run`;
      const sessionId = `${sessionKey}:session`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, updatedAt: 1_000, spawnDepth },
      );
      registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId,
        sessionKey,
        agentId: "main",
        now: 1_000,
        timeoutMs: 60_000,
      });
      registrations.push(registration);
      registration.markExecutionStarted();
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      await joinPersistence();
      expect(read(sessionKey).lifecycleRunId).toBe(runId);
      expect.soft(read(sessionKey).status).toBeUndefined();
      const active = resolveVisibleActiveSessionRunState({
        context: { chatAbortControllers },
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        agentId: "main",
      });
      expect(projectGatewaySessionActiveRun(active, read(sessionKey).status)).toEqual({
        status: "running",
        hasActiveRun: true,
      });
    }
    registrations[1]!.controller.abort(createAgentRunRestartAbortError());
    const warnings: string[] = [];
    await prepareGatewayRunShutdown({
      resolveGatewayContext: () => undefined,
      restart: true,
      timeoutMs: 0,
      warnings,
      getPendingReplyCount: () => 0,
      chatAbortControllers,
      chatQueuedTurns: new Map(),
      chatRunState: harness.chatRunState,
      agentRunSeq: harness.agentRunSeq,
      removeChatRun: () => undefined,
      broadcast: harness.broadcast,
      nodeSendToSession: harness.nodeSendToSession,
      markMainSessionsAbortedForRestart: async (params) => {
        await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
      },
    });
    await joinPersistence();
    expect(read(mainKey).mainRestartRecovery?.cycleId).toEqual(expect.any(String));
    expect(read(mainKey).restartRecoveryRuns).toContainEqual({
      runId: `${mainKey}:run`,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    expect(warnings).toContain("restart-reply-drain");
    for (const registration of registrations) {
      expect(registration.controller.signal.reason).toMatchObject({
        code: "OPENCLAW_RESTART_ABORT",
      });
    }
    expect.soft(read(childKey).status).toBe("interrupted");
    expect(hasLiveAgentRunContext(`${childKey}:run`)).toBe(false);
    const active = resolveVisibleActiveSessionRunState({
      context: { chatAbortControllers },
      requestedKey: childKey,
      canonicalKey: childKey,
      sessionId: read(childKey).sessionId,
      agentId: "main",
    });
    expect(active).toEqual({ active: false, runIds: [] });

    rotateAgentEventLifecycleGeneration();
    await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
    const mainTarget = { storePath, sessionKey: mainKey };
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const observed = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "observe",
        cycleId: "next-boot",
        lifecycleGeneration,
        sessionKey: mainKey,
      },
    });
    if (
      observed.transition.kind !== "observed" ||
      observed.transition.view.status !== "recoverable"
    ) {
      throw new Error("eligible dashboard main session lost its restart recovery owner");
    }
    const reserved = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "prepare_attempt",
        attempt: observed.transition.view.nextAttempt,
        observation: observed.transition.view.observation,
        lifecycleGeneration,
        runId: "resumed-main-run",
        now: Date.now(),
        executionIdentity: { state: "disabled" },
      },
    });
    expect(reserved.transition.kind).toBe("reserved");
    const admitted = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "admit_recovery",
        lifecycleGeneration,
        runId: "resumed-main-run",
        sessionId: read(mainKey).sessionId,
        now: Date.now(),
      },
    });
    expect(admitted.transition.kind).toBe("admitted_recovery");
    await persistGatewaySessionLifecycleEvent({
      sessionKey: mainKey,
      event: {
        runId: "resumed-main-run",
        sessionId: read(mainKey).sessionId,
        lifecycleGeneration,
        ts: Date.now(),
        data: { phase: "end" },
      },
    });
    expect(read(mainKey).status).toBe("done");
    const child = read(childKey);
    expect(child).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      endedAt: expect.any(Number),
      lastRunError: expect.stringContaining("restart"),
    });
    expect(child.lifecycleRunId).toBeUndefined();
    expect(child.restartRecoveryRuns).toBeUndefined();
    const row = buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath,
      key: childKey,
      store: { [childKey]: child },
      entry: child,
      activeModel: null,
      lightweightListRow: true,
    });
    expect(projectGatewaySessionActiveRun(active, row.status)).toEqual({
      status: "interrupted",
      hasActiveRun: false,
    });
  } finally {
    await unsubscribe();
    await joinPersistence();
    await harness.handler.dispose();
    for (const registration of registrations) {
      registration.cleanup();
    }
    clearAgentRunContext(`${childKey}:run`);
    clearAgentRunContext(`${mainKey}:run`);
  }
});

import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  markOrphanedMainSessionForRecovery,
  markRestartAbortedMainSessions,
} from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionEntries from "../config/sessions/session-accessor.sqlite-entry.js";
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
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
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
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

const cfg = { agents: { entries: { main: {} } } };
let state: OpenClawTestState;
let storePath: string;

type ShutdownParams = Parameters<typeof prepareGatewayRunShutdown>[0];
function shutdown(
  {
    chatRunState,
    agentRunSeq,
    broadcast,
    nodeSendToSession,
  }: Pick<ShutdownParams, "chatRunState" | "agentRunSeq" | "broadcast" | "nodeSendToSession">,
  resolveGatewayContext: GatewayContextResolver,
  overrides: Partial<ShutdownParams> = {},
) {
  return prepareGatewayRunShutdown({
    chatRunState,
    agentRunSeq,
    broadcast,
    nodeSendToSession,
    resolveGatewayContext,
    timeoutMs: 0,
    warnings: [],
    getPendingReplyCount: () => 0,
    removeChatRun: () => undefined,
    markMainSessionsAbortedForRestart: async (params) => {
      await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
    },
    ...overrides,
  });
}

function recoveryTarget(sessionKey: string, sessionId: string) {
  return captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
}

function registerRecoveryRun(
  params: Omit<Parameters<typeof registerChatAbortController>[0], "target"> & {
    sessionKey: string;
    resolveGatewayContext: GatewayContextResolver;
    storePath?: string;
  },
  timing?: Parameters<ReturnType<typeof registerChatAbortController>["initializeTiming"]>[0],
) {
  const { resolveGatewayContext, storePath: scopedStorePath, ...options } = params;
  const registration = registerChatAbortController({
    ...options,
    target: scopedStorePath
      ? captureSessionTarget({
          storeScope: scopedStorePath,
          sessionKey: options.sessionKey,
          incarnation: options.sessionId,
          agentId: options.agentId ?? "main",
        })
      : recoveryTarget(options.sessionKey, options.sessionId),
  });
  if (!registration.registered) {
    throw new Error("Expected a fresh recovery source");
  }
  bindGatewayContextResolver(registration.entry.input, resolveGatewayContext);
  registration.initializeTiming(timing);
  onTestFinished(async () => {
    const input = registration.entry.input;
    input.claim?.operation?.complete();
    if (input.claim) {
      releaseSessionControllerClaim(input.claim);
    }
    registration.cleanup();
    retireSessionControllerInput(input);
    await input.settlement.promise;
  });
  return registration;
}

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
  "other physical store",
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
  const admission = await beginSessionEffect({
    scope: storePath,
    identities: [sessionKey, sessionId],
    resolveGatewayContext,
    assertAllowed: () => {},
  });
  const registration = registerRecoveryRun({
    resolveGatewayContext,
    runId,
    sessionKey,
    sessionId,
    timeoutMs: 60_000,
  });
  const releaseClaim = await claimRpcSourceForTest(registration.entry);
  const shouldMark =
    releaseAt === "before planning" ||
    releaseAt === "before commit" ||
    releaseAt === "other physical store";
  if (releaseAt !== "user abort") {
    registration.controller.abort(createAgentRunRestartAbortError());
  }
  const release = async () => {
    releaseClaim();
    retireSessionControllerInput(registration.entry.input);
    await registration.entry.input.settlement.promise;
    registration.cleanup();
    admission.release();
    expect(getRpcSource(runId)).toBeUndefined();
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
          await release();
          return prepared;
        },
      }),
    );
  }
  const harness = createAgentEventTestHarness();
  let replacement: ReturnType<typeof registerRecoveryRun> | undefined;
  try {
    await shutdown(harness, resolveGatewayContext, {
      markMainSessionsAbortedForRestart: async (params) => {
        if (releaseAt === "user abort") {
          registration.controller.abort(createAgentRunDirectAbortError());
        }
        if (releaseAt === "completed" && registration.registered) {
          registration.entry.adapter.projectSessionTerminalPersisted = true;
        }
        if (releaseAt !== "before commit") {
          await release();
        }
        if (
          releaseAt === "replacement" ||
          releaseAt === "newer run" ||
          releaseAt === "other physical store"
        ) {
          replacement = registerRecoveryRun({
            resolveGatewayContext,
            runId: releaseAt === "newer run" ? "newer-run" : runId,
            sessionKey,
            sessionId,
            timeoutMs: 60_000,
            ...(releaseAt === "other physical store"
              ? { storePath: state.statePath("other-store", "sessions.json") }
              : {}),
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
    releaseClaim();
    retireSessionControllerInput(registration.entry.input);
    registration.cleanup();
    if (replacement) {
      retireSessionControllerInput(replacement.entry.input);
    }
    replacement?.cleanup();
    admission.release();
    await harness.handler.dispose();
  }
});

it.each(["admission", "queue", "delegated", "delegated source-only"] as const)(
  "retains %s work through shutdown and gives it one explicit recovery outcome",
  async (kind) => {
    const delegated = kind === "delegated" || kind === "delegated source-only";
    const sourceOnly = kind === "delegated source-only";
    const sessionKey = delegated ? "agent:main:main" : `agent:main:dashboard:restart-${kind}`;
    const sessionId = `restart-${kind}-session`;
    const runId = `restart-${kind}-run`;
    const target = { storePath, sessionKey };
    const resolveGatewayContext = () => undefined;
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: sourceOnly ? undefined : runId,
      restartRecoveryDeliverySourceRunId: runId,
      restartRecoverySourceIngress: sourceOnly ? undefined : delegated ? "internal" : "control-ui",
      ...(sourceOnly
        ? { restartRecoveryRuns: [{ runId, lifecycleGeneration: "before-restart" }] }
        : {}),
    });
    await appendTranscriptMessage(
      { ...target, sessionId },
      {
        message: {
          role: "user",
          content: "Finish the synthetic task after restart.",
          idempotencyKey: runId,
          ...(delegated ? { provenance: { kind: "inter_session" } } : {}),
        },
      },
    );
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext,
      assertAllowed: () => {},
    });
    const reply =
      kind === "queue"
        ? createReplyOperation({
            sessionKey,
            sessionId,
            resetTriggered: false,
            target: recoveryTarget(sessionKey, sessionId),
          })
        : undefined;
    const queued =
      kind === "queue"
        ? registerRecoveryRun({
            resolveGatewayContext,
            runId,
            sessionKey,
            sessionId,
            timeoutMs: 60_000,
            onCancel: () => admission.release(),
          })
        : undefined;
    let queueCancelledBeforeReply = false;
    if (reply) {
      bindGatewayContextResolver(reply, resolveGatewayContext);
      reply.abortSignal.addEventListener("abort", () => {
        queueCancelledBeforeReply = queued?.controller.signal.aborted === true;
      });
    }
    const gatewayRuntime = createMockGatewayRecoveryRuntime();
    vi.mocked(gatewayRuntime.dispatchAgent).mockResolvedValue({
      runId: "resumed-run",
      status: "ok",
    });
    const recoveryLog = vi.spyOn(mainSessionRecoveryLog, "info");
    try {
      const harness = createAgentEventTestHarness();
      await shutdown(harness, resolveGatewayContext);
      expect(loadSessionEntry(target)).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: expect.any(String) },
      });
      if (kind === "queue") {
        expect(queued?.controller.signal.reason).toMatchObject({ code: "OPENCLAW_RESTART_ABORT" });
        expect(getRpcSource(runId)).toBeUndefined();
        expect(admission.isActive()).toBe(false);
        expect(queueCancelledBeforeReply).toBe(true);
      }
      reply?.complete();
      queued?.cleanup();
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
      if (delegated) {
        expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
        const settled = loadSessionEntry(target);
        expect(settled).toMatchObject({
          sessionId,
          status: "interrupted",
          abortedLastRun: false,
          restartRecoveryTerminalRunIds: [runId],
        });
        expect(settled?.mainRestartRecovery).toBeUndefined();
        expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(settled?.restartRecoveryRuns).toBeUndefined();
        expect(settled?.restartRecoveryTerminalDeliveryEvidence).toBeUndefined();
        const transcript = JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }));
        expect(transcript).toContain("delegated recovery sender authority is unavailable");
        expect(transcript.match(/Send a new authenticated message to continue/g)).toHaveLength(1);
        expect(recoveryLog).toHaveBeenCalledWith(
          expect.stringContaining('"reason":"delegated_authority_unavailable"'),
        );
        rotateAgentEventLifecycleGeneration();
        expect(
          await markOrphanedMainSessionForRecovery({ target, expectedSessionId: sessionId, cfg }),
        ).toEqual({ marked: 0, skipped: 0 });
        await recover();
        expect(JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }))).toBe(
          transcript,
        );
        expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
      } else {
        expect(gatewayRuntime.dispatchAgent).toHaveBeenCalledTimes(1);
        expect(loadSessionEntry(target)).toMatchObject({ status: "done", abortedLastRun: false });
      }
    } finally {
      reply?.complete();
      if (queued) {
        retireSessionControllerInput(queued.entry.input);
        queued.cleanup();
      }
      admission.release();
      recoveryLog.mockRestore();
    }
  },
);

it.each(["none", "active", "pending"] as const)(
  "interrupts non-chat Gateway admission owners while preserving final writes (callback failure: %s)",
  async (callbackFailure) => {
    const sessionKey = `agent:main:dashboard:owned-shutdown-${callbackFailure}`;
    const sessionId = `owned-shutdown-${callbackFailure}`;
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
    const admission = await beginSessionEffect({
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
    const pending = beginSessionEffect({
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
    const finalAdmission = await beginSessionEffect({
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
    const sibling = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext: () => undefined,
      onInterrupt: siblingInterrupt,
    });
    const unbound = await beginSessionEffect({
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
    const successorInterrupt = vi.fn();
    let successor: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    const harness = createAgentEventTestHarness();
    try {
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      expect(pendingValidation).not.toHaveBeenCalled();
      const closing = await shutdown(harness, resolveGatewayContext, {
        markMainSessionsAbortedForRestart: async (params) => {
          await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
          successor = await beginSessionEffect({
            scope: storePath,
            identities: [sessionKey, sessionId],
            resolveGatewayContext,
            onInterrupt: successorInterrupt,
          });
        },
      });
      expect(controller.signal.aborted).toBe(true);
      expect(pendingController.signal.aborted).toBe(true);
      expect(recoveryMarkedBeforeInterruption).toBe(true);
      const [activeError, queuedError, pendingError] = await Promise.all([active, queued, pending]);
      for (const error of [activeError, queuedError, pendingError]) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ code: "OPENCLAW_RESTART_ABORT" });
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
      expect(successor?.isActive()).toBe(true);
      expect(successorInterrupt).not.toHaveBeenCalled();
      let released = false;
      void closing.released.then(
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
        await closing.released;
      } else {
        await expect(closing.released).rejects.toThrow(
          `Synthetic ${callbackFailure} admission cancellation failure`,
        );
      }
      expect(finalAdmission.isActive()).toBe(false);
      expect(successor?.isActive()).toBe(true);
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
      successor?.release();
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
    const resolveGatewayContext = () => undefined;
    const params = {
      ...createSubscriptionTestFixture().createParams(),
      resolveGatewayContext,
    };
    params.chatRunState.registry.add(runId, { sessionKey, clientRunId });
    const registration = registerSubscriptionChatRun(params, {
      runId: clientRunId,
      sessionKey,
      sessionId,
      agentId: "main",
      target: recoveryTarget(sessionKey, sessionId),
    });
    bindGatewayContextResolver(registration.entry.input, resolveGatewayContext);
    const releaseClaim = await claimRpcSourceForTest(registration.entry);
    registration.markExecutionStarted();
    registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
    const unsubs = startGatewayEventSubscriptions(params);
    let unsubscribeAgent: Promise<void> | undefined;
    const drain = () => (unsubscribeAgent ??= unsubs.agentUnsub());
    let replacement: ReturnType<typeof registerSubscriptionChatRun> | undefined;
    let releaseReplacementClaim: (() => void) | undefined;
    const replacementRunId = `${runId}-replacement`;
    const writeEntered = createDeferred();
    const releaseWrite = createDeferred();
    const patch = sessionEntries.applySessionEntryTargetOperation;
    const heldWrite = retireWhilePersisting
      ? vi
          .spyOn(sessionEntries, "applySessionEntryTargetOperation")
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
        releaseClaim();
        registration.cleanup();
        expect(getRpcSource(clientRunId)).toBe(registration.entry);
        expect(registration.entry.adapter.projectSessionTerminalPending).toBe(true);
        releaseWrite.resolve();
      }
      await waitForChatAbortTerminalPersistence(registration.entry);
      releaseClaim();
      registration.cleanup();
      await registration.entry.input.settlement.promise;
      expect(getRpcSource(clientRunId)).toBeUndefined();
      expect(loadSessionEntry(target)).toMatchObject({
        status: completed ? "done" : "interrupted",
        abortedLastRun: !completed,
        lastRunId: clientRunId,
      });

      await shutdown(params, resolveGatewayContext, {
        restartRecoveryCandidates: params.restartRecoveryCandidates,
        markMainSessionsAbortedForRestart: async (captured) => {
          if (outcome === "replacement") {
            // The old terminal is already durable; a newer turn wins before its marker writes.
            replacement = registerSubscriptionChatRun(params, {
              runId: replacementRunId,
              sessionKey,
              sessionId,
              agentId: "main",
              target: recoveryTarget(sessionKey, sessionId),
            });
            bindGatewayContextResolver(replacement.entry.input, resolveGatewayContext);
            releaseReplacementClaim = await claimRpcSourceForTest(replacement.entry);
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
      heartbeatNotifications.onEvent = () => {};
      unsubs.transcriptUnsub();
      unsubs.lifecycleUnsub();
      releaseClaim();
      releaseReplacementClaim?.();
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
  const resolveGatewayContext = () => undefined;
  const persist = vi.fn(persistGatewaySessionLifecycleEvent);
  const harness = createAgentEventTestHarness({
    persistGatewaySessionLifecycleEventForEvent: persist,
  });
  harness.clearAgentRunContext.mockImplementation(clearAgentRunContext);
  const unsubscribe = subscribeAgentEvents(harness.handler);
  const registrations: Array<ReturnType<typeof registerRecoveryRun>> = [];
  const releases: Array<() => void> = [];
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
      const registration = registerRecoveryRun(
        {
          resolveGatewayContext,
          runId,
          sessionId,
          sessionKey,
          agentId: "main",
          timeoutMs: 60_000,
        },
        { now: 1_000 },
      );
      registrations.push(registration);
      releases.push(await claimRpcSourceForTest(registration.entry));
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
        storePath,
        resolveGatewayContext,
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
    await shutdown(harness, resolveGatewayContext, {
      warnings,
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
      storePath,
      resolveGatewayContext,
      requestedKey: childKey,
      canonicalKey: childKey,
      sessionId: read(childKey).sessionId,
      agentId: "main",
    });
    expect(active).toEqual({ active: false, runIds: [] });

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
    for (const release of releases) {
      release();
    }
    for (const registration of registrations) {
      registration.cleanup();
    }
    clearAgentRunContext(`${childKey}:run`);
    clearAgentRunContext(`${mainKey}:run`);
  }
});

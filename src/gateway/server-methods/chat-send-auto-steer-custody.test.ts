import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { runReplyAgent } from "../../auto-reply/reply/agent-runner-run.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { getExistingFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "../../auto-reply/reply/reply-operation-run-state.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { ChatHistoryPage } from "../../config/sessions/session-history-types.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

const mocks = vi.hoisted(() => ({
  readHistory: vi.fn<(...args: unknown[]) => Promise<ChatHistoryPage>>(),
  providerGeneration: "initial",
  received: vi.fn(),
}));
vi.mock("../../config/sessions/session-history-worker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../config/sessions/session-history-worker-runtime.js")
  >()),
  readSessionHistoryPageInWorker: mocks.readHistory,
}));
vi.mock("../../decisions/runtime.js", () => ({
  inspectDecisionProviders: () => [
    {
      providerId: "test-provider",
      pluginId: "test-provider",
      callable: true,
      runtimeGeneration: mocks.providerGeneration,
    },
  ],
}));
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: mocks.received,
}));

installGatewayTestHooks({ scope: "suite" });
const createBrowserFixture = useBrowserFollowupFixture();
afterEach(() => vi.useRealTimers());
type Dispatch = Parameters<typeof dispatchInboundMessage>[0];

async function createFixture(
  baseline: "steer" | "collect" = "steer",
  choice: "steer" | "followup" = "followup",
) {
  const fixture = await createBrowserFixture({ preserveContent: true });
  const operation = fixture.activeRun;
  if (!operation) {
    throw new Error("Expected active reply owner");
  }
  const config = getRuntimeConfig();
  setRuntimeConfigSnapshot({
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        experimental: { ...config.agents?.defaults?.experimental, decisionAssistance: true },
        decisionModel: "test-provider/decision-model",
      },
    },
    messages: { ...config.messages, queue: { ...config.messages?.queue, mode: baseline } },
  });
  fixture.params.deliveryPolicy = "auto";
  fixture.params.idempotencyKey = "late-route-input";
  fixture.params.message = "An independent new request.";
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.providerGeneration = "initial";
  mocks.received.mockClear();
  mocks.readHistory.mockReset().mockResolvedValue({
    messages: [
      { role: "user", content: "Original task", idempotencyKey: "source-turn:user" },
      { role: "assistant", content: "Working on it." },
    ],
  });
  const registry = getTestPluginRegistry();
  const decide = vi.fn(async () => ({ status: "choice" as const, choice }));
  registry.typedHooks.push({
    pluginId: "auto-route-fixture",
    source: "test",
    hookName: "input_route",
    handler: decide,
  });
  initializeGlobalHookRunner(registry);
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "auto-tools",
    project: () => "auto-tools",
  });
  operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
  operation.setPhase("running");
  replyRunRegistry.bindSourceTurnId(operation, "source-turn");
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (_text, options, assertCurrent) => {
      assertCurrent();
      options?.onQueueAccepted?.(true);
      const committed = await options?.userTurnTranscriptRecorder?.persistApproved();
      if (!committed) {
        throw new Error("Missing source input custody");
      }
    },
  );
  operation.attachBackend({
    kind: "embedded",
    runId: "source-backend",
    toolAuthorityFingerprint: "auto-tools",
    cancel: vi.fn(),
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  const entered = createDeferred<Dispatch>();
  const release = createDeferred();
  const finished = createDeferred();
  const state: ReplyOperationRunState = {};
  let dispatchTask: Promise<void> | undefined;
  // Pause only dispatch preparation. Handler/admission, the actual reply runner,
  // followup queue, cancellation lifecycle, and transcript custody stay real.
  dispatchInboundMessageMock.mockImplementation((value: unknown) => {
    const dispatch = value as Dispatch;
    dispatchTask = (async () => {
      entered.resolve(dispatch);
      await release.promise;
      const opts = dispatch.replyOptions;
      const followupRun = createQueueTestRun({
        prompt: fixture.params.message,
        messageId: fixture.params.idempotencyKey,
      });
      followupRun.run.agentId = fixture.scope.agentId;
      followupRun.run.sessionId = fixture.scope.sessionId;
      followupRun.run.sessionKey = fixture.scope.sessionKey;
      followupRun.run.config = getRuntimeConfig();
      followupRun.userTurnTranscriptRecorder = opts?.userTurnTranscriptRecorder;
      followupRun.turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
      followupRun.abortSignal = opts?.abortSignal;
      await runReplyAgent({
        commandBody: fixture.params.message,
        followupRun,
        queueKey: fixture.scope.sessionKey,
        sessionKey: fixture.scope.sessionKey,
        resolvedQueue: { mode: opts?.queueModeOverride ?? "steer", debounceMs: 0 },
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
        opts: { ...opts, [REPLY_OPERATION_RUN_STATE]: state },
        typing: createMockTypingController(),
        sessionCtx: dispatch.ctx,
        defaultModel: "test-provider/test-model",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "text_end",
        shouldInjectGroupIntro: false,
        typingMode: "never",
      });
    })();
    return dispatchTask.finally(() => finished.resolve()).then(() => ({}));
  });
  return {
    ...fixture,
    operation,
    queueMessage,
    decide,
    clock,
    entered,
    release,
    finish: () => finished.promise.then(() => dispatchTask),
    state,
    cleanup: async () => {
      release.resolve();
      await dispatchTask?.catch(() => {});
      clearSessionQueues([fixture.scope.sessionKey]);
      operation.abortByUser();
      operation.complete();
      await getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });
      dispatchInboundMessageMock.mockReset();
      clock.mockRestore();
      vi.useRealTimers();
    },
  };
}

async function sendToDispatch(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const response = await fixture.send();
  expect(response).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started" }),
    undefined,
    expect.anything(),
  );
  const dispatch = await fixture.entered.promise;
  expect(dispatch.replyOptions?.queueModeOverride).toBe("followup");
  expect(fixture.context.chatQueuedTurns.size).toBe(0);
  expect(fixture.queueMessage).not.toHaveBeenCalled();
  expect(listSessionPendingInputs(fixture.scope).total).toBe(1);
  return dispatch;
}

describe("Auto final followup custody", () => {
  it.each(["deadline", "labs", "plugin", "provider"] as const)(
    "revalidates %s after dispatch preparation, steers the original input once, and never replays dispatch hooks",
    async (invalidation) => {
      const fixture = await createFixture();
      try {
        await sendToDispatch(fixture);
        const config = getRuntimeConfig();
        if (invalidation === "deadline") {
          fixture.clock.mockReturnValue(601);
        }
        if (invalidation === "labs") {
          setRuntimeConfigSnapshot({
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, experimental: { decisionAssistance: false } },
            },
          });
        }
        if (invalidation === "plugin") {
          setRuntimeConfigSnapshot({
            ...config,
            plugins: {
              ...config.plugins,
              entries: { ...config.plugins?.entries, "auto-route-fixture": { enabled: false } },
            },
          });
        }
        if (invalidation === "provider") {
          mocks.providerGeneration = "replacement";
        }
        fixture.release.resolve();
        await fixture.finish();
        expect(fixture.queueMessage).toHaveBeenCalledOnce();
        expect(fixture.state.admission).toEqual({ status: "accepted", mode: "steer" });
        expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items ?? []).toEqual([]);
        expect(fixture.context.chatQueuedTurns.size).toBe(0);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        // The dispatch seam owns its message hook; late steering must not emit it again.
        expect(mocks.received).not.toHaveBeenCalled();
        expect(fixture.decide).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(fixture.scope).total).toBe(0);
        const messages = loadTranscriptEventsSync(fixture.scope)
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "user");
        expect(messages).toHaveLength(2);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("keeps valid followup advice until actual queue acceptance, then releases source ordering", async () => {
    const fixture = await createFixture();
    try {
      await sendToDispatch(fixture);
      const next = fixture.operation.reserveInputRouting();
      let nextReady = false;
      void next.ready.then(() => {
        nextReady = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(nextReady).toBe(false);
      fixture.release.resolve();
      await fixture.finish();
      await next.ready;
      expect(getExistingFollowupQueue(fixture.scope.sessionKey)).toMatchObject({
        mode: "followup",
        items: [expect.objectContaining({ messageId: fixture.params.idempotencyKey })],
      });
      expect(fixture.context.chatQueuedTurns.size).toBe(1);
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(fixture.state.admission).toEqual({ status: "accepted", mode: "followup" });
      next.release();
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves the same prepared input in baseline queue custody when late steering is rejected", async () => {
    const fixture = await createFixture();
    try {
      await sendToDispatch(fixture);
      fixture.clock.mockReturnValue(601);
      fixture.queueMessage.mockImplementationOnce(async () => {
        throw new Error("Rejected before custody");
      });
      fixture.release.resolve();
      await fixture.finish();
      expect(fixture.queueMessage).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(fixture.scope.sessionKey)).toMatchObject({
        mode: "steer",
        items: [
          expect.objectContaining({
            messageId: fixture.params.idempotencyKey,
            prompt: fixture.params.message,
          }),
        ],
      });
      expect(fixture.context.chatQueuedTurns.size).toBe(1);
      expect(listSessionPendingInputs(fixture.scope).total).toBe(1);
      expect(fixture.state.admission).toEqual({ status: "accepted", mode: "followup" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not retry a steer already rejected before dispatch", async () => {
    const fixture = await createFixture("steer", "steer");
    try {
      fixture.queueMessage.mockImplementation(async () => {
        throw new Error("Rejected before custody");
      });
      await fixture.send();
      const dispatch = await fixture.entered.promise;
      expect(dispatch.replyOptions?.queueModeOverride).toBe("steer");
      fixture.release.resolve();
      await fixture.finish();
      expect(fixture.queueMessage).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items).toHaveLength(1);
      expect(fixture.context.chatQueuedTurns.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps Stop authoritative while dispatch is preparing followup custody", async () => {
    const fixture = await createFixture();
    try {
      await sendToDispatch(fixture);
      fixture.operation.abortByUser();
      fixture.release.resolve();
      await expect(fixture.finish()).rejects.toBeDefined();
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(fixture.scope.sessionKey)?.items ?? []).toEqual([]);
      expect(fixture.context.chatQueuedTurns.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("restores inherited Collect rather than queueing stale Followup advice", async () => {
    const fixture = await createFixture("collect");
    try {
      await sendToDispatch(fixture);
      fixture.clock.mockReturnValue(601);
      fixture.release.resolve();
      await fixture.finish();
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(fixture.scope.sessionKey)).toMatchObject({
        mode: "collect",
        items: [expect.objectContaining({ messageId: fixture.params.idempotencyKey })],
      });
      expect(fixture.context.chatQueuedTurns.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
import { expectedNoQueuedReplyResult } from "./dispatch-result-expectations.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let expireStaleReplyOperation: typeof import("./reply-run-registry.state.js").expireStaleReplyOperation;
let REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS: typeof import("./reply-run-registry.contracts.js").REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const sessionKey = "agent:main:telegram:direct:1";

function createVisibleDispatchParams(
  replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]>,
) {
  return {
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageThreadId: "501.000",
      BodyForAgent: "second telegram direct turn",
    }),
    cfg: {},
    dispatcher: createDispatcher(),
    replyResolver,
  };
}

describe("dispatchReplyFromConfig visible admission recovery", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js"));
    ({ expireStaleReplyOperation } = await import("./reply-run-registry.state.js"));
    ({ REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS } = await import("./reply-run-registry.contracts.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.entriesBySessionKey.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("reclaims a leftover active reply operation when the session entry is terminal/killed", async () => {
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId: "active-session",
      status: "killed",
      updatedAt: Date.now(),
    };

    const replyResolver = vi.fn(async (_ctx, options) => {
      options?.onAgentRunStart?.("successful-run");
      return { text: "telegram reply" } satisfies ReplyPayload;
    });
    const dispatchParams = createVisibleDispatchParams(replyResolver);

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(activeOperation.result).toMatchObject({
      kind: "failed",
      code: "run_failed",
      cause: { message: "clearing stale terminal reply operation" },
    });
    expect(result.queuedFinal).toBe(true);
    expect(readAgentRunTerminalOutcome(result)).toBe("completed");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("renders post-compaction context after dispatcher normalization", async () => {
    const dispatchParams = createVisibleDispatchParams(async () =>
      setReplyPayloadMetadata(
        { text: formatBillingErrorMessage(), isError: true },
        { postCompactionModelFailure: true },
      ),
    );

    await dispatchReplyFromConfig(dispatchParams);

    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: `⚠️ Context compaction succeeded, but the later model request still failed. ${formatBillingErrorMessage().replace(/^⚠️\s*/u, "")}`,
      isError: true,
    });
  });

  it("records a failed reply operation when recovering a visible partial", async () => {
    const resolverError = new Error("provider failed after partial");
    let replyOperation: ReturnType<typeof createReplyOperation> | undefined;
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      if (!options) {
        throw new Error("reply options required for partial recovery");
      }
      replyOperation = options.replyOperation;
      options.onAgentRunStart?.("failed-run");
      await options.onPartialReply?.({ text: "partial telegram reply" });
      throw resolverError;
    };
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: {
        onPartialReply: vi.fn(async () => undefined),
      },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(replyOperation?.result).toEqual({
      kind: "failed",
      code: "run_failed",
      cause: resolverError,
    });
    expect(result.queuedFinal).toBe(true);
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(dispatchParams.replyOptions.onPartialReply).toHaveBeenCalledWith({
      text: "partial telegram reply",
    });
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") }),
    );
  });

  it("rethrows post-run dispatch errors after a completed run with no visible reply", async () => {
    const resolverError = new Error("final delivery failed after completion");
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      options?.onAgentRunTerminalOutcome?.("completed");
      throw resolverError;
    };

    await expect(dispatchReplyFromConfig(createVisibleDispatchParams(replyResolver))).rejects.toBe(
      resolverError,
    );
  });

  it("records a terminal agent failure before the first visible reply", async () => {
    const resolverError = new Error("provider failed before output");
    let replyOperation: ReturnType<typeof createReplyOperation> | undefined;
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      if (!options) {
        throw new Error("reply options required for terminal failure");
      }
      replyOperation = options.replyOperation;
      options.onAgentRunTerminalOutcome?.("failed");
      throw resolverError;
    };
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" as const },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(replyOperation?.result).toEqual({
      kind: "failed",
      code: "run_failed",
      cause: resolverError,
    });
    expect(result).toMatchObject(expectedNoQueuedReplyResult());
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", false, false, "allow", "slack", true],
    ["group", true, true, "allow", "slack", true],
    ["group", false, false, "allow", "slack", false],
    ["group", false, false, "disallow", "slack", true],
    ["direct", true, false, "allow", "discord", true],
  ] as const)(
    "settles an adopted %s failure (progress=%s, mentioned=%s, silence=%s, origin=%s)",
    async (chatType, progress, mentioned, silentReply, origin, expectedFinal) => {
      const surface = "slack";
      sessionStoreMocks.currentEntry = { verboseLevel: "on" };
      const resolverError = new Error("private synthetic failure detail");
      const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, { kind }) => {
          delivered.push({ kind, payload });
        },
      });
      mocks.routeReply.mockImplementation(async (raw) => {
        const { payload, replyKind: kind } = raw as { payload: ReplyPayload; replyKind: string };
        delivered.push({ kind, payload });
        return { ok: true, delivered: true };
      });
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
        _ctx,
        options,
      ) => {
        operation = options?.replyOperation;
        await options?.turnAdoptionLifecycle?.onAdopted();
        if (progress) {
          await options?.onToolResult?.({
            text: "Got it. I am checking now.",
            isStatusNotice: true,
          });
          await dispatcher.waitForIdle();
          expect(delivered.map(({ kind }) => kind)).toEqual(["tool"]);
        }
        throw resolverError;
      };
      const params = {
        ...createVisibleDispatchParams(replyResolver),
        cfg: { agents: { defaults: { silentReply: { group: silentReply } } } },
        dispatcher,
        replyOptions: {
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) },
        },
      };
      Object.assign(params.ctx, {
        Provider: surface,
        Surface: surface,
        OriginatingChannel: origin,
        ChatType: chatType,
        WasMentioned: mentioned,
      });
      const { result, processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
        withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig(params) }),
      );

      expect(delivered.map(({ kind }) => kind)).toEqual(
        expectedFinal ? (progress ? ["tool", "final"] : ["final"]) : [],
      );
      if (expectedFinal) {
        expect(delivered.at(-1)?.payload).toMatchObject({
          text: expect.stringContaining("Something went wrong"),
          isError: true,
        });
      }
      expect(JSON.stringify(delivered)).not.toContain(resolverError.message);
      expect(operation?.result).toEqual({
        kind: "failed",
        code: "run_failed",
        cause: resolverError,
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(processedOutcome?.outcome).toBe("error");
      if (origin !== surface) {
        expect(mocks.routeReply).toHaveBeenLastCalledWith(
          expect.objectContaining({
            channel: origin,
            to: "user:1",
            threadId: "501.000",
            replyKind: "final",
          }),
        );
      }
    },
  );

  it.each(["before adoption", "adoption rejected"])(
    "keeps %s failures retryable without a final notice",
    async (failure) => {
      const resolverError = new Error(failure);
      const onAdopted = vi.fn(async () => {
        throw resolverError;
      });
      const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
      const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
        async (_ctx, options) => {
          if (failure === "adoption rejected") {
            await options?.turnAdoptionLifecycle?.onAdopted();
          }
          throw resolverError;
        },
      );
      const params = {
        ...createVisibleDispatchParams(replyResolver),
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: { onAdopted } },
      };
      params.ctx.MessageSid = "retryable-failure";
      await expect(
        withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig(params) }),
      ).rejects.toBe(resolverError);
      expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
      replyResolver.mockResolvedValueOnce({ text: "retry succeeded" });
      await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
      expect(replyResolver).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["message_tool_only", "send-denied", "observed-delivery", "room-event"])(
    "does not add an adopted failure notice for %s",
    async (policy) => {
      const params = createVisibleDispatchParams(async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        if (policy === "observed-delivery") {
          await options?.onObservedReplyDelivery?.();
        }
        throw new Error("adopted failure");
      });
      params.ctx.MessageSid = "adopted-suppressed-failure";
      if (policy === "send-denied") {
        sessionStoreMocks.currentEntry = { sendPolicy: "deny" };
      }
      if (policy === "room-event") {
        params.ctx.InboundEventKind = "room_event";
      }
      const result = await dispatchReplyFromConfig({
        ...params,
        replyOptions: {
          ...(policy === "message_tool_only"
            ? { sourceReplyDeliveryMode: "message_tool_only" as const }
            : {}),
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) },
        },
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(params.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("retains adopted dedupe when failure-notice preparation also fails", async () => {
    const resolverError = new Error("accepted turn failed");
    const deliveryError = new Error("final preparation failed");
    const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
      async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        throw resolverError;
      },
    );
    const params = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) } },
    };
    params.ctx.MessageSid = "adopted-final-failure";
    ttsMocks.maybeApplyTtsToPayload.mockRejectedValueOnce(deliveryError);
    await expect(dispatchReplyFromConfig(params)).rejects.toBe(deliveryError);
    await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  it("waits for fresh visible reply work without invoking diagnostic recovery", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    activeOperation.abortSignal.addEventListener("abort", () => activeOperation.complete(), {
      once: true,
    });
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    let settled = false;

    const resultPromise = dispatchReplyFromConfig(dispatchParams).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();

    activeOperation.complete();
    const result = await resultPromise;

    expect(result.queuedFinal).toBe(true);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("reclaims stale pre-backend work after bounded terminal settlement", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const resultPromise = dispatchReplyFromConfig(dispatchParams);
    await vi.waitFor(() => {
      expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
    expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);

    await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
    const result = await resultPromise;

    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(result.queuedFinal).toBe(true);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: "no_activity", continued: undefined, notice: true },
    { reason: "stuck_recovery", continued: undefined, notice: true },
    { reason: "stuck_recovery", continued: false, notice: true },
    { reason: "stuck_recovery", continued: true, notice: false },
    { reason: "finalization_stalled", continued: true, notice: false },
    // A final message-tool answer reached the source before the watchdog fired.
    { reason: "stuck_recovery", continued: true, notice: false, answered: true },
    // A newer input steered in after that answer still needs one.
    { reason: "stuck_recovery", continued: true, notice: false, answered: true, steered: true },
  ] as const)(
    "sends the stall notice only as a last resort ($reason, continued=$continued)",
    async ({ reason, continued, notice, ...testCase }) => {
      const answered = "answered" in testCase;
      const steered = "steered" in testCase;
      const resolverStarted = createDeferred();
      const continueStalledTurn = vi.fn(() => continued === true);
      const dispatchParams = createVisibleDispatchParams(async (_ctx, options) => {
        const runState = resolveReplyOperationRunState(options);
        if (runState && continued !== undefined) {
          runState.continueStalledTurn = continueStalledTurn;
        }
        if (answered) {
          replyRunRegistry.get(sessionKey)?.markSourceReplyDelivered();
        }
        if (steered) {
          replyRunRegistry.get(sessionKey)?.markSteeredInputAccepted({ inboundAudio: false });
        }
        resolverStarted.resolve();
        await new Promise<void>((resolve) => {
          options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const error = new Error("reply expired");
        error.name = "AbortError";
        throw error;
      });

      const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
      await resolverStarted.promise;
      const operation = replyRunRegistry.get(sessionKey);
      expect(operation).toBeDefined();
      expect(expireStaleReplyOperation(operation!, reason)).toBe(false);

      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: notice });
      expect(continueStalledTurn).toHaveBeenCalledTimes(
        continued !== undefined && reason !== "finalization_stalled" && (!answered || steered)
          ? 1
          : 0,
      );
      if (notice) {
        expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
          text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
          isError: true,
        });
      } else {
        expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps a queued channel turn accepted when the busy session frees before final admission", async () => {
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    sessionStoreMocks.currentEntry = { sessionId: "active-session", updatedAt: Date.now() };
    const runState: ReplyOperationRunState = {};
    const dispatchParams = createVisibleDispatchParams(async () => {
      // The turn queues behind pending follow-up work; the owner settles before
      // dispatch reacquires the now-idle session for final delivery.
      runState.admission = { status: "accepted", mode: "followup" };
      activeOperation.complete();
      return undefined;
    });

    await expect(
      dispatchReplyFromConfig({
        ...dispatchParams,
        replyOptions: {
          [REPLY_OPERATION_RUN_STATE]: runState,
          turnAdoptionLifecycle: { admission: "exclusive", onAdopted: () => {} },
        },
      }),
    ).resolves.toMatchObject({ queuedFinal: false });
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });
});

import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setVerbose } from "../../global-state.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import { applyLoggingConfig, flushLogger, resetLogger } from "../../logging/logger.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
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
let createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;

let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const sessionKey = "agent:main:telegram:direct:1";
const sessionTarget = captureSessionTarget({
  storeScope: "/tmp/mock-sessions.json",
  sessionKey,
  agentId: "main",
});

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
  let processedEvents: Extract<DiagnosticEventPayload, { type: "message.processed" }>[];
  let dispatchEvents: Extract<DiagnosticEventPayload, { type: "message.dispatch.completed" }>[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation } = await import("../../sessions/session-controller.js"));

    ({ testing: controllerTesting } =
      await import("../../sessions/session-controller.test-support.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    resetLogger();
    setVerbose(false);
    vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    applyLoggingConfig({
      file: path.join(tempDirs.make("dispatch-diagnostics-"), "gateway.log"),
      consoleLevel: "silent",
    });
    processedEvents = [];
    dispatchEvents = [];
    unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.processed") {
        processedEvents.push(event);
      } else if (event.type === "message.dispatch.completed") {
        dispatchEvents.push(event);
      }
    });
    diagnosticMocks.forwardToRealPipeline = true;
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.entriesBySessionKey.clear();
  });

  afterEach(async () => {
    await flushLogger();
    resetLogger();
    setVerbose(false);
    vi.unstubAllEnvs();
    unsubscribe();
    diagnosticMocks.forwardToRealPipeline = false;
    vi.useRealTimers();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
  });

  it("does not force-clear a live raw owner because its persisted row is terminal", async () => {
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
      target: sessionTarget,
    });
    activeOperation.setPhase("running");
    const inspected = createDeferred();
    const tick = vi.spyOn(activeOperation.watchdog, "tick").mockImplementation(async () => {
      inspected.resolve();
      return { action: "observe", reason: "live raw owner" };
    });
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

    const pending = dispatchReplyFromConfig(dispatchParams);
    await inspected.promise;
    expect(tick).toHaveBeenCalledOnce();
    expect(activeOperation.result).toBeNull();
    expect(replyResolver).not.toHaveBeenCalled();
    activeOperation.complete();
    const result = await pending;
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });

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

  it.each([
    { name: "info", logging: { level: "info" }, detail: false },
    { name: "debug", logging: { level: "debug" }, detail: true },
    { name: "environment info", logging: { level: "debug" }, env: "info", detail: false },
  ] satisfies Array<{
    name: string;
    logging: NonNullable<OpenClawConfig["logging"]>;
    detail: boolean;
    env?: string;
  }>)(
    "recovers a visible partial with $name diagnostics",
    async ({ logging, detail, ...testCase }) => {
      vi.stubEnv("OPENCLAW_LOG_LEVEL", "env" in testCase ? testCase.env : undefined);
      applyLoggingConfig({
        file: path.join(tempDirs.make("dispatch-diagnostic-level-"), "gateway.log"),
        consoleLevel: "silent",
        ...logging,
        redactPatterns: ["private-start-.*?-private-end"],
      });
      const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
      const customSecret = `private-start-${"x".repeat(2_500)}-private-end`;
      const resolverError = new Error(
        `provider failed after partial: ${secret} ${customSecret} preserved-after-redaction ${"🦞".repeat(1_100)}`,
      );
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
        cfg: { diagnostics: { enabled: true } },
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
      for (const events of [processedEvents, dispatchEvents]) {
        expect(events).toEqual([
          expect.objectContaining({
            outcome: "error",
            sessionKey,
            durationMs: expect.any(Number),
            error: detail ? expect.stringContaining("preserved-after-redaction") : undefined,
          }),
        ]);
        expect(JSON.stringify(events)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain("x".repeat(64));
        if (detail) {
          expect(events[0]?.error?.length).toBeLessThanOrEqual(2_048);
          expect(events[0]?.error?.isWellFormed()).toBe(true);
        }
      }
      expect(dispatchEvents[0]?.error).toBe(processedEvents[0]?.error);
      expect(dispatchParams.replyOptions.onPartialReply).toHaveBeenCalledWith({
        text: "partial telegram reply",
      });
      expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Check the conversation before trying again"),
        }),
      );
    },
  );

  it("reads lazy partial text only until a visible partial has content", async () => {
    const resolverError = new Error("provider failed after partials");
    const textReads: string[] = [];
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      let text = "";
      for (let index = 0; index < 256; index++) {
        await options?.onPartialReply?.({
          get text() {
            textReads.push(text);
            return text;
          },
        });
        text += "x";
      }
      throw resolverError;
    };
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { onPartialReply: vi.fn(async () => true) },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(textReads).toEqual(["", "x"]);
    expect(result.queuedFinal).toBe(true);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Check the conversation before trying again"),
      }),
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
    ["group", true, true, "allow", "slack", true],
    ["group", false, false, "allow", "slack", false],
    ["direct", true, false, "allow", "discord", true],
    ["direct", false, false, "allow", "webchat", true],
  ] as const)(
    "settles an adopted %s failure (progress=%s, mentioned=%s, silence=%s, origin=%s)",
    async (chatType, progress, mentioned, silentReply, origin, expectedFinal) => {
      const surface = origin === "webchat" ? "webchat" : "slack";
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
        cfg: {
          diagnostics: { enabled: true },
          agents: { defaults: { silentReply: { group: silentReply } } },
        },
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
        expect(delivered.at(-1)?.payload.isError).toBe(true);
        expect(delivered.at(-1)?.payload.text?.trim()).toBeTruthy();
      }
      expect(JSON.stringify(delivered)).not.toContain(resolverError.message);
      expect(operation?.result).toEqual({
        kind: "failed",
        code: "run_failed",
        cause: resolverError,
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(processedOutcome?.outcome).toBe("error");
      expect(processedEvents).toEqual([
        expect.objectContaining({ outcome: "error", error: undefined }),
      ]);
      if (expectedFinal && origin !== surface) {
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

  it("keeps rejected adoption retryable without a final notice", async () => {
    const resolverError = new Error("adoption rejected");
    const onAdopted = vi.fn(async () => {
      throw resolverError;
    });
    const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
    const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
      async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
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
  });

  it.each(["observed-delivery", "room-event"])(
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
      if (policy === "room-event") {
        params.ctx.InboundEventKind = "room_event";
      }
      const result = await dispatchReplyFromConfig({
        ...params,
        replyOptions: {
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
      target: sessionTarget,
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

  it("retains a stalled producer until its real settlement before admitting the next turn", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
      target: sessionTarget,
    });
    activeOperation.setPhase("running");
    const releaseProducer = activeOperation.retainExecution();
    expect(activeOperation.abortForStall()).toBe(true);
    activeOperation.complete();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const pending = dispatchReplyFromConfig(createVisibleDispatchParams(replyResolver));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(getSessionControllerOperation(sessionKey, sessionTarget)).toBe(activeOperation);
    expect(replyResolver).not.toHaveBeenCalled();

    releaseProducer();
    const result = await pending;
    expect(result.queuedFinal).toBe(true);
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  it.each([
    { continued: undefined, notice: true },
    { continued: false, notice: true },
    { continued: true, notice: false },
    // A final message-tool answer reached the source before the watchdog fired.
    { continued: true, notice: false, answered: true },
    // A newer input steered in after that answer still needs one.
    { continued: true, notice: false, answered: true, steered: true },
  ] as const)(
    "sends the watchdog stall notice only as a last resort (continued=$continued)",
    async ({ continued, notice, ...testCase }) => {
      const answered = "answered" in testCase;
      const steered = "steered" in testCase;
      const resolverStarted = createDeferred();
      const continueStalledTurn = vi.fn(() => continued === true);
      const dispatchParams = createVisibleDispatchParams(async (_ctx, options) => {
        const runState = resolveReplyOperationRunState(options);
        if (runState && continued !== undefined) {
          runState.continueStalledTurn = continueStalledTurn;
        }
        const operation = getSessionControllerOperation(sessionKey);
        if (!operation) {
          throw new Error("dispatch did not bind its reply operation");
        }
        if (answered) {
          operation.markSourceReplyDelivered();
        }
        if (steered) {
          operation.markSteeredInputAccepted({ inboundAudio: false });
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
      const operation = getSessionControllerOperation(sessionKey);
      expect(operation).toBeDefined();
      expect(operation?.abortForStall()).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: notice });
      expect(continueStalledTurn).toHaveBeenCalledTimes(
        continued !== undefined && (!answered || steered) ? 1 : 0,
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
      target: sessionTarget,
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

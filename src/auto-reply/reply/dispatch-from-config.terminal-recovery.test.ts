import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { setVerbose } from "../../global-state.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import {
  applyLoggingConfig,
  flushLogger,
  resetLogger,
  setLoggerOverride,
} from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import * as channels from "../../test-utils/channel-plugins.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  acpMocks,
  createDispatcher,
  diagnosticMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
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

type ReplyResolver = NonNullable<DispatchFromConfigParams["replyResolver"]>;

const sessionKey = "agent:main:telegram:direct:1";
const sessionTarget = captureSessionTarget({
  storeScope: "/tmp/mock-sessions.json",
  sessionKey,
  agentId: "main",
});

function createActiveOperation() {
  const operation = createReplyOperation({
    sessionKey,
    sessionId: "active-session",
    resetTriggered: false,
    target: sessionTarget,
  });
  operation.setPhase("running");
  return operation;
}

function createVisibleDispatchParams(
  replyResolver: ReplyResolver,
  overrides: Partial<Pick<DispatchFromConfigParams, "cfg" | "dispatcher" | "replyOptions">> = {},
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
    ...overrides,
  };
}

const adoptedOptions = () => ({ turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) } });
function expectFailure(
  operation: ReturnType<typeof createReplyOperation> | undefined,
  cause: Error,
) {
  expect(operation?.result).toEqual({ kind: "failed", code: "run_failed", cause });
}

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ createReplyOperation } = await import("../../sessions/session-controller.js"));

  ({ testing: controllerTesting } =
    await import("../../sessions/session-controller.test-support.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
});

beforeEach(() => {
  controllerTesting.resetSessionControllerForTest();
  resetInboundDedupe();
  resetPluginTtsAndThreadMocks();
  mocks.routeReply.mockReset();
  mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  mocks.tryFastAbortFromMessage.mockReset();
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
});

describe("dispatchReplyFromConfig visible admission recovery", () => {
  let processedEvents: Extract<DiagnosticEventPayload, { type: "message.processed" }>[];
  let dispatchEvents: Extract<DiagnosticEventPayload, { type: "message.dispatch.completed" }>[];
  let unsubscribe: () => void;

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
  ] as const)(
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
      const textReads: string[] = [];
      let replyOperation: ReturnType<typeof createReplyOperation> | undefined;
      const replyResolver: ReplyResolver = async (_ctx, options) => {
        replyOperation = options?.replyOperation;
        options?.onAgentRunStart?.("failed-run");
        let text = "";
        for (let index = 0; index < 256; index++) {
          await options?.onPartialReply?.({
            get text() {
              textReads.push(text);
              return text;
            },
          });
          text += index ? "x" : "partial telegram reply";
        }
        throw resolverError;
      };
      const dispatchParams = createVisibleDispatchParams(replyResolver, {
        cfg: { diagnostics: { enabled: true } },
        replyOptions: { onPartialReply: vi.fn(async () => (detail ? true : undefined)) },
      });

      const result = await dispatchReplyFromConfig(dispatchParams);
      expect(textReads).toEqual(["", "partial telegram reply"]);
      expectFailure(replyOperation, resolverError);
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
      expect(dispatchParams.replyOptions?.onPartialReply).toHaveBeenCalledTimes(256);
      expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Check the conversation before trying again"),
        }),
      );
    },
  );

  it("rethrows post-run dispatch errors after a completed run with no visible reply", async () => {
    const resolverError = new Error("final delivery failed after completion");
    const replyResolver: ReplyResolver = async (_ctx, options) => {
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
    const replyResolver: ReplyResolver = async (_ctx, options) => {
      replyOperation = options?.replyOperation;
      options?.onAgentRunTerminalOutcome?.("failed");
      throw resolverError;
    };
    const dispatchParams = createVisibleDispatchParams(replyResolver, {
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await dispatchReplyFromConfig(dispatchParams);

    expectFailure(replyOperation, resolverError);
    expect(result).toMatchObject(expectedNoQueuedReplyResult());
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    ["group", true, true, "slack", true],
    ["group", false, false, "slack", false],
    ["direct", true, false, "discord", true],
    ["direct", false, false, "webchat", true],
  ] as const)(
    "settles an adopted %s failure (progress=%s, mentioned=%s, origin=%s)",
    async (chatType, progress, mentioned, origin, expectedFinal) => {
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
      const replyResolver: ReplyResolver = async (_ctx, options) => {
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
      const params = createVisibleDispatchParams(replyResolver, {
        cfg: {
          diagnostics: { enabled: true },
          agents: { defaults: { silentReply: { group: "allow" } } },
        },
        dispatcher,
        replyOptions: adoptedOptions(),
      });
      Object.assign(params.ctx, {
        Provider: surface,
        Surface: surface,
        OriginatingChannel: origin,
        ChatType: chatType,
        WasMentioned: mentioned,
      });
      const result = await withReplyDispatcher({
        dispatcher,
        run: () => dispatchReplyFromConfig(params),
      });

      expect(delivered.map(({ kind }) => kind)).toEqual(
        expectedFinal ? (progress ? ["tool", "final"] : ["final"]) : [],
      );
      if (expectedFinal) {
        expect(delivered.at(-1)?.payload.isError).toBe(true);
        expect(delivered.at(-1)?.payload.text?.trim()).toBeTruthy();
      }
      expect(JSON.stringify(delivered)).not.toContain(resolverError.message);
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
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

  it.each([false, true])(
    "retries ingress only when adoption was rejected (adopted=%s)",
    async (adopted) => {
      const resolverError = new Error("turn failed");
      const deliveryError = new Error("final preparation failed");
      const onAdopted = vi.fn(async () => {
        if (!adopted) {
          throw resolverError;
        }
      });
      const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
      const replyResolver = vi.fn<ReplyResolver>(async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        throw resolverError;
      });
      const params = createVisibleDispatchParams(replyResolver, {
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: { onAdopted } },
      });
      params.ctx.MessageSid = "adoption-retryability";
      if (adopted) {
        ttsMocks.maybeApplyTtsToPayload.mockRejectedValueOnce(deliveryError);
      }
      await expect(
        withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig(params) }),
      ).rejects.toBe(adopted ? deliveryError : resolverError);
      if (!adopted) {
        expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
      }
      replyResolver.mockResolvedValueOnce({ text: "retry succeeded" });
      await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
      expect(replyResolver).toHaveBeenCalledTimes(adopted ? 1 : 2);
    },
  );

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
        replyOptions: adoptedOptions(),
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(params.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("waits for the active producer despite a terminal session row", async () => {
    const activeOperation = createActiveOperation();
    const inspected = createDeferred();
    vi.spyOn(activeOperation.watchdog, "tick").mockImplementation(async () => {
      inspected.resolve();
      return { action: "observe", reason: "live raw owner" };
    });
    sessionStoreMocks.currentEntry = {
      sessionId: "active-session",
      status: "killed",
      updatedAt: Date.now(),
    };
    let resolverOperation: ReturnType<typeof createReplyOperation> | undefined;
    const replyResolver = vi.fn<ReplyResolver>(async (_ctx, options) => {
      resolverOperation = options?.replyOperation;
      options?.onAgentRunStart?.("successful-run");
      return { text: "telegram reply" };
    });
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    let settled = false;

    const resultPromise = withReplyDispatcher({
      dispatcher: dispatchParams.dispatcher,
      run: () => dispatchReplyFromConfig(dispatchParams),
    }).then((result) => {
      settled = true;
      return result;
    });

    await inspected.promise;
    expect(activeOperation.result).toBeNull();
    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();
    activeOperation.complete();
    const result = await resultPromise;

    expect(result.queuedFinal).toBe(true);
    expect(result.counts).toEqual({ tool: 0, block: 0, final: 0 });
    expect(readAgentRunTerminalOutcome(result)).toBe("completed");
    if (!resolverOperation) {
      throw new Error("dispatch did not expose its reply operation");
    }
    await resolverOperation.ownerSettlement;
    expect(resolverOperation.watchdog.snapshot()).toMatchObject({
      current: false,
      phase: "settled",
    });
  });

  it.each<[boolean | undefined, boolean, boolean?, boolean?]>([
    [undefined, true],
    [false, true],
    [true, false],
    // A final message-tool answer reached the source before the watchdog fired.
    [true, false, true],
    // A newer input steered in after that answer still needs one.
    [true, false, true, true],
  ] as const)(
    "sends the watchdog stall notice only as a last resort (continued=%s, notice=%s)",
    async (continued, notice, answered = false, steered = false) => {
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
    const activeOperation = createActiveOperation();
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

describe("restart tombstone channel feedback", () => {
  const notice =
    "My session in this room ended during restart recovery. Use Resume in WebChat, or /reset or /new to start a replacement session.";
  const warn = vi.fn();
  const deliver = vi.fn(async () => {});
  const replyResolver = vi.fn(async () => ({ text: "agent reply" }));
  let recoverySessionKey: string;
  let messageId: number;

  const recoveryMarker = (cycleId = "failed-cycle") => ({
    cycleId,
    revision: 4,
    chargedAttempts: 3,
    tombstone: { reason: "automatic recovery exhausted" },
  });

  beforeEach(() => {
    clearAgentHarnesses();
    setActivePluginRegistry(
      channels.createTestRegistry([
        {
          pluginId: "buzz",
          source: "test",
          plugin: channels.createChannelTestPluginBase({ id: "buzz" }),
        },
      ]),
    );
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    sessionStoreMocks.loadSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    warn.mockClear();
    deliver.mockClear();
    replyResolver.mockClear();
    recoverySessionKey = `agent:main:buzz:group:buzz:${randomUUID()}`;
    messageId = 0;
    sessionStoreMocks.currentEntry = {
      sessionId: "failed-session",
      updatedAt: Date.now(),
      status: "failed",
      mainRestartRecovery: recoveryMarker(),
    };
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  });

  afterEach(() => {
    loggingState.rawConsole = null;
    setLoggerOverride(null);
  });

  async function rejectInbound(options?: {
    context?: Partial<MsgContext>;
    visibleReplies?: "automatic" | "message_tool";
    sendPolicy?: "allow" | "deny";
  }) {
    const dispatcher = createReplyDispatcher({ deliver });
    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "buzz",
          Surface: "buzz",
          OriginatingChannel: "buzz",
          OriginatingTo: "buzz:00000000-0000-4000-8000-000000000001",
          ChatType: "group",
          SessionKey: recoverySessionKey,
          MessageSid: String(++messageId),
          Body: "Can you answer?",
          RawBody: "Can you answer?",
          CommandBody: "Can you answer?",
          InboundAccessAuthorized: true,
          InboundEventKind: "user_request",
          InputProvenance: { kind: "external_user", sourceChannel: "buzz" },
          WasMentioned: true,
          ...options?.context,
        }),
        cfg: {
          messages: { groupChat: { visibleReplies: options?.visibleReplies ?? "automatic" } },
          ...(options?.sendPolicy
            ? { session: { sendPolicy: { default: options.sendPolicy } } }
            : {}),
        },
        dispatcher,
        replyResolver,
      }),
    ).rejects.toThrow(/ended during restart recovery/i);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }

  it("delivers one message-tool room notice and warns for every rejected inbound", async () => {
    let elapsedMs = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const diagnosticsWereEnabled = diagnostics.areDiagnosticsEnabledForProcess();
    diagnostics.setDiagnosticsEnabledForProcess(true);
    onTestFinished(() => {
      clock.mockRestore();
      diagnostics.setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    });
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
      elapsedMs += 1_500;
      return sessionStoreMocks.currentEntry;
    });
    // Uncontended lifecycle effects stay quiet even when their own work is slow.
    const rejectionWarnings = () =>
      warn.mock.calls.filter(([line]) => line.includes("[auto-reply/reply-turn-admission]"));
    await rejectInbound({ visibleReplies: "message_tool" });
    expect(rejectionWarnings()).toHaveLength(1);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: notice }),
      expect.objectContaining({ kind: "final" }),
    );
    await rejectInbound({ visibleReplies: "message_tool" });
    expect(deliver).toHaveBeenCalledOnce();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(rejectionWarnings()).toHaveLength(2);
    for (const [line] of rejectionWarnings()) {
      expect(line).toContain(recoverySessionKey);
      expect(line).toContain("automatic recovery exhausted");
      expect(line).toContain("/reset");
    }
    expect(warn.mock.calls.map(([line]) => stripVTControlCharacters(line))).not.toContainEqual(
      expect.stringContaining("[sessions/lifecycle] slow session lifecycle operation"),
    );
    expect(sessionStoreMocks.currentEntry).toMatchObject({
      sessionId: "failed-session",
      mainRestartRecovery: { tombstone: { reason: "automatic recovery exhausted" } },
    });
  });

  it.each(["session", "cycle"] as const)("notifies again for a new recovery %s", async (change) => {
    await rejectInbound();
    if (change === "session") {
      sessionStoreMocks.currentEntry!.sessionId = "replacement-session";
    } else {
      sessionStoreMocks.currentEntry!.mainRestartRecovery = recoveryMarker("replacement-cycle");
    }
    await rejectInbound();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("keeps model-locked recovery guidance actionable", async () => {
    sessionStoreMocks.currentEntry!.modelSelectionLocked = true;
    await rejectInbound();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: expect.stringContaining("WebChat and use Resume."),
      }),
      expect.objectContaining({ kind: "final" }),
    );
  });

  it("warns about ambiguous routed delivery without repeating the notice", async () => {
    mocks.routeReply.mockResolvedValueOnce({ ok: true, delivered: true, ambiguous: true });
    const context = { Provider: "slack", Surface: "slack" };
    await rejectInbound({ context });
    await rejectInbound({ context });
    expect(mocks.routeReply).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("notice delivery was not confirmed"));
  });

  it.each([
    { label: "unauthorized inbound", context: { InboundAccessAuthorized: false } },
    { label: "explicit send-policy denial", sendPolicy: "deny" as const },
    { label: "ACP privacy after waiting for admission", acp: true },
    { label: "send policy after waiting for admission", latePolicy: true },
  ])("does not notify for $label", async ({ context, sendPolicy, acp, latePolicy }) => {
    if (acp || latePolicy) {
      sessionStoreMocks.loadSessionEntry.mockImplementation(() => {
        if (acp) {
          acpMocks.readAcpSessionEntry.mockReturnValue({
            entry: { sessionId: "failed-session", spawnedBy: "agent:main:parent" },
            acp: { backend: "acpx", mode: "persistent" },
          });
        } else {
          sessionStoreMocks.currentEntry!.sendPolicy = "deny";
        }
        return sessionStoreMocks.currentEntry;
      });
    }
    await rejectInbound({ context, sendPolicy });
    expect(deliver).not.toHaveBeenCalled();
  });
});

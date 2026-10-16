// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { noteDispatchProcessedOutcome } from "../../auto-reply/reply/dispatch-processed-outcome.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { getReplySystemEventContext } from "../../auto-reply/reply/system-event-session-key.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { runPreparedChannelTurn } from "./execution.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createRecordInboundSession,
  createDispatch,
  createReplyDispatchReceipt,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import type { AssembledChannelTurn, PreparedChannelTurn } from "./types.js";

const subsystemWarn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  const makeLogger = (subsystem: string): import("../../logging/subsystem.js").SubsystemLogger => ({
    subsystem,
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: subsystemWarn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: (name: string) => makeLogger(`${subsystem}/${name}`),
  });
  return {
    ...actual,
    createSubsystemLogger: makeLogger,
  };
});

const {
  emitMessageSent,
  getGlobalHookRunner,
  createMessageSentEmitter,
  readRecentUserAssistantTextForSession,
} = channelTurnMocks;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let storePath: string;
function dispatchTestAssembledTurn(overrides: Partial<AssembledChannelTurn>) {
  return dispatchAssembledChannelTurn({
    cfg: {},
    agentId: "main",
    storePath,
    channel: "feishu",
    routeSessionKey: "agent:main:feishu:peer",
    ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
    recordInboundSession: createRecordInboundSession(),
    dispatchReplyWithBufferedBlockDispatcher: createDispatch(),
    delivery: { deliver: async () => ({ visibleReplySent: true }) },
    ...overrides,
  });
}

function runTestPreparedChannelTurn<TDispatchResult>(
  params: Pick<PreparedChannelTurn<TDispatchResult>, "runDispatch" | "log" | "messageId">,
) {
  return runPreparedChannelTurn({
    channel: "test",
    routeSessionKey: "agent:main:test:peer",
    storePath,
    ctxPayload: createCtx(),
    recordInboundSession: createRecordInboundSession(),
    ...params,
  });
}

describe("channel turn pipeline", () => {
  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-channel-turn-pipeline-"), "sessions.json");
    vi.clearAllMocks();
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info" });
    createMessageSentEmitter.mockImplementation(() => ({
      emitMessageSent,
      hasMessageSentHooks: true,
    }));
    getGlobalHookRunner.mockReturnValue(null);
    readRecentUserAssistantTextForSession.mockResolvedValue([]);
  });

  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });

  it("does not emit a second failure when a post-send observer throws", async () => {
    const observerError = new Error("observer failed");
    const onError = vi.fn();

    await expect(
      dispatchTestAssembledTurn({
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ messageIds: ["om-visible"], visibleReplySent: true }),
          onDelivered: () => {
            throw observerError;
          },
          onError,
        },
      }),
    ).rejects.toBe(observerError);

    expect(emitMessageSent).toHaveBeenCalledExactlyOnceWith({
      success: true,
      content: "reply",
      messageId: "om-visible",
    });
    expect(onError).not.toHaveBeenCalled();
    expect(observerError).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });

  it("observes early finalization rejection and reports the original failure", async () => {
    const { promise: finalization, reject: rejectFinalization } = createDeferred<never>();
    const catchSpy = vi.spyOn(finalization, "catch");
    const finalizationError = new Error("final edit failed", {
      cause: new Error("provider rejected edit"),
    });
    const onError = vi.fn();
    const dispatch = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "requested final" }, { kind: "final" });
      expect(catchSpy).toHaveBeenCalledOnce();
      rejectFinalization(finalizationError);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ visibleReplySent: false, finalization }),
          onError,
        },
      }),
    ).rejects.toBe(finalizationError);

    expect(emitMessageSent).toHaveBeenCalledExactlyOnceWith({
      success: false,
      content: "requested final",
      error: "final edit failed | provider rejected edit",
      messageId: undefined,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(finalizationError, { kind: "final" });
  });

  it("preserves a null dispatch rejection through the assembled-turn boundary", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "requested final" }, { kind: "final" });
      const nullRejection: unknown = null;
      return new Promise((resolve, reject) => {
        const rejectWithUnknown = reject as (reason?: unknown) => void;
        void resolve;
        rejectWithUnknown(nullRejection);
      });
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        channel: "feishu",
        routeSessionKey: "agent:main:feishu:peer",
        ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ visibleReplySent: false }),
        },
      }),
    ).rejects.toThrow("channel dispatch failed");
  });

  it("preserves the visible partial error over other finalization and dispatch failures", async () => {
    const { promise: firstFinalization, reject: rejectFirst } = createDeferred<never>();
    const { promise: secondFinalization, reject: rejectSecond } = createDeferred<never>();
    const firstError = new Error("first finalization failed");
    const partialError = Object.assign(new Error("second finalization failed"), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted second preview",
        messageIds: ["om-second-preview"],
        visibleReplySent: true,
      },
    });
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: firstFinalization })
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: secondFinalization });
    const dispatch = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "first requested" }, { kind: "final" });
      await params.dispatcherOptions.deliver({ text: "second requested" }, { kind: "final" });
      rejectFirst(firstError);
      rejectSecond(partialError);
      throw new Error("stream close failed");
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        delivery: { observeMessageSent: true, deliver },
      }),
    ).rejects.toBe(partialError);

    expect(emitMessageSent).toHaveBeenCalledTimes(2);
    expect(emitMessageSent).toHaveBeenNthCalledWith(1, {
      success: false,
      content: "first requested",
      error: "first finalization failed",
      messageId: undefined,
    });
    expect(emitMessageSent).toHaveBeenNthCalledWith(2, {
      success: false,
      content: "accepted second preview",
      error: "second finalization failed",
      messageId: "om-second-preview",
    });
  });

  it("suppresses message_sent when the adapter proves provider dispatch never began", async () => {
    const dispatch = vi.fn(async (params) => {
      try {
        await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
      } catch {
        // The buffered dispatcher already owns delivery-error reporting.
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      delivery: {
        observeMessageSent: true,
        deliver: async () => {
          throw new PlatformMessageNotDispatchedError("local media load failed", {
            cause: new Error("missing file"),
          });
        },
      },
    });

    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("settles visible replies even when a suppression observer throws", async () => {
    const observerError = new Error("suppression observer failed");
    const finalized = {
      visibleReplySent: true,
      messageIds: ["om-public"],
      content: "public reply",
    };
    const deliver = vi.fn(async () => ({
      visibleReplySent: false,
      finalization: Promise.resolve(finalized),
    }));
    const onDelivered = vi.fn<NonNullable<AssembledChannelTurn["delivery"]["onDelivered"]>>(
      (payload) => {
        if (payload.text === "private reply") {
          throw observerError;
        }
      },
    );
    const dispatch = vi.fn(async (params) => {
      const dispatcher = createReplyDispatcher(params.dispatcherOptions);
      expect(dispatcher.sendFinalReply({ text: "private reply" })).toBe(false);
      expect(dispatcher.sendFinalReply({ text: "public reply" })).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: dispatcher.getQueuedCounts().final > 0,
        counts: dispatcher.getQueuedCounts(),
      };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    const turn = dispatchTestAssembledTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      delivery: { deliver, onDelivered, observeMessageSent: true },
      replyPipeline: {
        transformReplyPayload: (payload) => (payload.text === "private reply" ? null : payload),
      },
    });

    await expect(turn).rejects.toBe(observerError);

    expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "public reply" }, { kind: "final" });
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "private reply" },
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: { reason: "channel_transform" },
      },
    );
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "public reply" },
      { kind: "final" },
      expect.objectContaining(finalized),
    );
    expect(emitMessageSent).toHaveBeenCalledExactlyOnceWith({
      success: true,
      content: "public reply",
      messageId: "om-public",
    });
  });

  it("can record a target session without changing the command dispatch session", async () => {
    const log = vi.fn();
    const events: string[] = [];
    const recordInboundSession = createRecordInboundSession(events);
    const onAdopted = vi.fn(async () => {
      events.push("adopted");
    });
    const turnAdoptionLifecycle = { onAdopted };
    const dispatch = vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
      expect(params.ctx).not.toHaveProperty("SystemEventSessionKey");
      expect(params.ctx.SessionKey).toBe(commandSessionKey);
      expect(getReplySystemEventContext({ ...params.replyOptions })?.sessionKey).toBe(
        routeSessionKey,
      );
      events.push("dispatch");
      expect(params.replyOptions?.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
      await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
      await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const routeSessionKey = "agent:main:telegram:group:42";
    const commandSessionKey = "agent:main:command:telegram:42";
    const targetSessionKey = "agent:main:telegram:group:42:topic:7";

    const result = await dispatchTestAssembledTurn({
      channel: "telegram",
      routeSessionKey,
      ctxPayload: createCtx({
        AgentId: "main",
        SessionKey: commandSessionKey,
        CommandTargetSessionKey: targetSessionKey,
        SessionTranscriptContext: { historyLimit: 1 },
      }),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      turnAdoptionLifecycle,
      record: { sessionKey: targetSessionKey },
      log,
      afterRecord: async () => {
        events.push("afterRecord");
      },
    });

    expectDispatched(result);
    expect(events).toEqual(["record", "afterRecord", "dispatch", "adopted"]);
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    );
    expect(result.routeSessionKey).toBe(routeSessionKey);
    expect(result.ctxPayload.SessionKey).toBe(commandSessionKey);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: targetSessionKey }),
    );
    expect(readRecentUserAssistantTextForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: targetSessionKey,
        storePath,
      }),
    );
  });

  it("rejects surrounding whitespace in an explicit record session", async () => {
    const historyMap = new Map([["room", [{ sender: "Alice", body: "pending" }]]]);
    const recordInboundSession = createRecordInboundSession();
    await expect(
      dispatchTestAssembledTurn({
        recordInboundSession,
        history: { isGroup: true, historyKey: "room", historyMap, limit: 1 },
        record: { sessionKey: " agent:main:telegram:group:42 " },
      }),
    ).rejects.toThrow("Channel turn record.sessionKey must not include surrounding whitespace.");
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(historyMap.get("room")).toStrictEqual([]);
  });

  it("attributes the zero-count warn line with the dispatch's processed outcome", async () => {
    const log = vi.fn();
    const runDispatch = vi.fn(async () => {
      noteDispatchProcessedOutcome({ outcome: "skipped", reason: "duplicate" });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
        settledReceipt: createReplyDispatchReceipt({ final: { deliveredNotVisible: 1 } }),
      };
    });

    const result = await runTestPreparedChannelTurn({
      runDispatch,
      log,
      messageId: "msg-zero-cause",
    });

    expectDispatched(result);
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("messageId=msg-zero-cause"));
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("cause=skipped:duplicate"));
    // The channel log event is a plugin contract; the attribution must stay out of it.
    const warning = log.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.reason === "zero-count-visible-dispatch");
    expect(warning).toBeDefined();
    expect(warning).not.toHaveProperty("cause");
  });

  it("does not warn for deferred steer with zero queued counts", async () => {
    const signal = { deferredToActiveRun: "steer" } as const;
    const log = vi.fn();
    const result = await runTestPreparedChannelTurn({
      log,
      messageId: "msg-zero",
      runDispatch: async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        ...signal,
      }),
    });
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject(signal);
    expect(log.mock.calls).not.toContainEqual([
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    ]);
  });
});

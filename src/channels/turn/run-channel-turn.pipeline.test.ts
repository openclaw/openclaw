// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { noteDispatchProcessedOutcome } from "../../auto-reply/reply/dispatch-processed-outcome.js";
import type { DispatchReplyWithBufferedBlockDispatcher as Dispatch } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { getReplySystemEventContext } from "../../auto-reply/reply/system-event-session-key.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { runPreparedChannelTurn } from "./execution.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createRecordInboundSession,
  createDispatch,
  createReplyDispatchReceipt,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import * as fixture from "./turn-state.test-support.js";
import type { AssembledChannelTurn, ChannelTurnLogEvent } from "./types.js";

const subsystemWarn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
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
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: makeLogger,
  };
});

const { emitMessageSent, readRecentUserAssistantTextForSession: readRecent } = channelTurnMocks;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let storePath: string;
function dispatchTestAssembledTurn(overrides: Partial<AssembledChannelTurn>) {
  return dispatchAssembledChannelTurn(
    fixture.assembledTurn(storePath, {
      channel: "feishu",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
      delivery: { deliver: async () => ({ visibleReplySent: true }) },
      ...overrides,
    }),
  );
}
function runDelivery(
  delivery: AssembledChannelTurn["delivery"],
  dispatch = createDispatch(),
  overrides: Partial<AssembledChannelTurn> = {},
) {
  return dispatchTestAssembledTurn({
    ...overrides,
    dispatchReplyWithBufferedBlockDispatcher: dispatch,
    delivery: { observeMessageSent: true, ...delivery },
  });
}

describe("channel turn pipeline", () => {
  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-channel-turn-pipeline-"), "sessions.json");
    fixture.resetTurnState();
    readRecent.mockResolvedValue([]);
  });

  afterEach(fixture.resetTurnLogger);

  it("does not emit a second failure when a post-send observer throws", async () => {
    const observerError = new Error("observer failed");
    const onError = vi.fn();

    await expect(
      runDelivery({
        deliver: async () => ({ messageIds: ["om-visible"], visibleReplySent: true }),
        onDelivered: () => {
          throw observerError;
        },
        onError,
      }),
    ).rejects.toBe(observerError);

    fixture.expectMessagesSent(["reply", "om-visible"]);
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
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "requested final" }, fixture.finalInfo);
      expect(catchSpy).toHaveBeenCalledOnce();
      rejectFinalization(finalizationError);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return fixture.finalDispatch();
    });

    await expect(
      runDelivery(
        {
          deliver: async () => ({ visibleReplySent: false, finalization }),
          onError,
        },
        dispatch,
      ),
    ).rejects.toBe(finalizationError);

    fixture.expectMessagesSent([
      "requested final",
      undefined,
      "final edit failed | provider rejected edit",
    ]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(finalizationError, fixture.finalInfo);
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
    }) as Dispatch;

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
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "first requested" }, fixture.finalInfo);
      await dispatcherOptions.deliver({ text: "second requested" }, fixture.finalInfo);
      rejectFirst(firstError);
      rejectSecond(partialError);
      throw new Error("stream close failed");
    });

    await expect(runDelivery({ deliver }, dispatch)).rejects.toBe(partialError);

    fixture.expectMessagesSent(
      ["first requested", undefined, "first finalization failed"],
      ["accepted second preview", "om-second-preview", "second finalization failed"],
    );
  });

  it("suppresses message_sent when the adapter proves provider dispatch never began", async () => {
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ ...fixture.reply }, fixture.finalInfo);
      } catch {
        // The buffered dispatcher already owns delivery-error reporting.
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });

    await runDelivery(
      {
        deliver: async () => {
          throw new PlatformMessageNotDispatchedError("local media load failed", {
            cause: new Error("missing file"),
          });
        },
      },
      dispatch,
    );

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
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      expect(dispatcher.sendFinalReply({ text: "private reply" })).toBe(false);
      expect(dispatcher.sendFinalReply({ text: "public reply" })).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: dispatcher.getQueuedCounts().final > 0,
        counts: dispatcher.getQueuedCounts(),
      };
    });

    const turn = runDelivery({ deliver, onDelivered }, dispatch, {
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      replyPipeline: {
        transformReplyPayload: (payload) => (payload.text === "private reply" ? null : payload),
      },
    });

    await expect(turn).rejects.toBe(observerError);

    expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "public reply" }, fixture.finalInfo);
    expect(onDelivered).toHaveBeenCalledWith({ text: "private reply" }, fixture.finalInfo, {
      visibleReplySent: false,
      suppression: { reason: "channel_transform" },
    });
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "public reply" },
      fixture.finalInfo,
      expect.objectContaining(finalized),
    );
    fixture.expectMessagesSent(["public reply", "om-public"]);
  });

  it("can record a target session without changing the command dispatch session", async () => {
    const log = vi.fn();
    const events: string[] = [];
    const recordInboundSession = createRecordInboundSession(events);
    const onAdopted = vi.fn(async () => {
      events.push("adopted");
    });
    const turnAdoptionLifecycle = { onAdopted };
    const dispatch = vi.fn<Dispatch>(async ({ ctx, replyOptions, dispatcherOptions }) => {
      expect(ctx).not.toHaveProperty("SystemEventSessionKey");
      expect(ctx.SessionKey).toBe(commandSessionKey);
      expect(getReplySystemEventContext({ ...replyOptions })?.sessionKey).toBe(routeSessionKey);
      events.push("dispatch");
      expect(replyOptions?.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
      await dispatcherOptions.deliver({ ...fixture.reply }, fixture.finalInfo);
      return fixture.finalDispatch();
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
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    );
    expect(result).toMatchObject({
      routeSessionKey,
      ctxPayload: { SessionKey: commandSessionKey },
    });
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: targetSessionKey }),
    );
    expect(readRecent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey: targetSessionKey, storePath }),
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

  it("keeps zero-visible diagnostic attribution internal", async () => {
    const log = vi.fn<(event: ChannelTurnLogEvent) => void>();
    const result = await runPreparedChannelTurn({
      ...fixture.turnContext(storePath),
      log,
      messageId: "msg-zero-cause",
      runDispatch: async () => {
        noteDispatchProcessedOutcome({ outcome: "skipped", reason: "duplicate" });
        return {
          ...fixture.finalDispatch(),
          settledReceipt: createReplyDispatchReceipt({ final: { deliveredNotVisible: 1 } }),
        };
      },
    });

    expectDispatched(result);
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("messageId=msg-zero-cause"));
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("cause=skipped:duplicate"));
    const warning = log.mock.calls
      .map(([event]) => event)
      .find((event) => event.reason === "zero-count-visible-dispatch");
    expect(warning).toBeDefined();
    expect(warning).not.toHaveProperty("cause");
  });

  it("does not warn for a steer deferred to the active run", async () => {
    const log = vi.fn();
    const signal = { deferredToActiveRun: "steer" } as const;
    const result = await runPreparedChannelTurn({
      ...fixture.turnContext(storePath),
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

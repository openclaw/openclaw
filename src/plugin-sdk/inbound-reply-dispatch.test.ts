import path from "node:path";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { RecordInboundSession } from "../channels/session.types.js";
import type { ChannelTurnResult } from "../channels/turn/types.js";
import {
  dispatchChannelInboundReply,
  dispatchChannelInboundTurn,
  runPreparedInboundReply,
} from "./channel-inbound.js";
import * as legacy from "./inbound-reply-dispatch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the deprecated package subpath compatibility exports", () => {
  const callableExports = [
    "hasFinalInboundReplyDispatch",
    "hasVisibleInboundReplyDispatch",
    "resolveInboundReplyDispatchCounts",
    "recordDroppedChannelTurnHistory",
    "recordDroppedChannelInboundHistory",
    "recordChannelBotPairLoopAndCheckSuppression",
    "deliverInboundReplyWithMessageSendContext",
    "dispatchInboundReplyWithBase",
    "runPreparedInboundReply",
    "runChannelInboundEvent",
    "dispatchChannelInboundReply",
  ] as const;

  for (const exportName of callableExports) {
    expect(legacy[exportName], exportName).toBeTypeOf("function");
  }

  type LegacyTypeExports = [
    legacy.AssembledInboundReply,
    legacy.ChannelBotLoopProtectionFacts,
    legacy.ChannelInboundDroppedHistoryOptions,
    legacy.ChannelInboundEventRunnerParams<unknown>,
    legacy.ChannelTurnDroppedHistoryOptions,
    legacy.ChannelTurnRecordOptions,
    legacy.DurableInboundReplyDeliveryParams,
    legacy.InboundReplyDispatchResult<unknown>,
    legacy.InboundReplyRecordOptions,
    legacy.PreparedInboundReply<unknown>,
  ];
  expectTypeOf<LegacyTypeExports>().not.toBeNever();
});

it("keeps public channel-inbound entry points drop-capable", () => {
  type DispatchResult = { queuedFinal: true };
  expectTypeOf(runPreparedInboundReply<DispatchResult>).returns.toEqualTypeOf<
    Promise<ChannelTurnResult<DispatchResult>>
  >();
  expectTypeOf(dispatchChannelInboundReply).returns.toEqualTypeOf<Promise<ChannelTurnResult>>();
  expectTypeOf(dispatchChannelInboundTurn).returns.toEqualTypeOf<Promise<ChannelTurnResult>>();
});

it("records and dispatches through dispatchInboundReplyWithBase", async () => {
  const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
  const deliver = vi.fn(async () => undefined);
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
    await params.dispatcherOptions.deliver(
      { text: "hello", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  }) as DispatchReplyWithBufferedBlockDispatcher;
  const ctxPayload = {
    Body: "body",
    RawBody: "body",
    CommandBody: "body",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
  } as FinalizedMsgContext;

  await legacy.dispatchInboundReplyWithBase({
    cfg: {},
    channel: "test",
    accountId: "default",
    route: { agentId: "main", sessionKey: "agent:main:test:peer" },
    storePath: path.join(tempDirs.make("openclaw-inbound-reply-dispatch-"), "sessions.json"),
    ctxPayload,
    core: {
      channel: {
        session: { recordInboundSession },
        reply: { dispatchReplyWithBufferedBlockDispatcher },
      },
    },
    deliver,
    onRecordError: vi.fn(),
    onDispatchError: vi.fn(),
  });

  expect(recordInboundSession).toHaveBeenCalledOnce();
  expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledWith({
    text: "hello",
    mediaUrls: ["https://example.com/a.png"],
    mediaUrl: undefined,
    sensitiveMedia: undefined,
    replyToId: undefined,
  });
});

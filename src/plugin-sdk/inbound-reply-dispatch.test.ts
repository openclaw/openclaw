import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { RecordInboundSession } from "../channels/session.types.js";
import type { ChannelTurnResult } from "../channels/turn/types.js";
import {
  dispatchChannelInboundReply,
  dispatchChannelInboundTurn,
  runPreparedInboundReply,
} from "./channel-inbound.js";
import * as legacy from "./inbound-reply-dispatch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps public channel-inbound entry points drop-capable", () => {
  type DispatchResult = { queuedFinal: true };
  expectTypeOf(runPreparedInboundReply<DispatchResult>).returns.toEqualTypeOf<
    Promise<ChannelTurnResult<DispatchResult>>
  >();
  expectTypeOf(dispatchChannelInboundReply).returns.toEqualTypeOf<Promise<ChannelTurnResult>>();
  expectTypeOf(dispatchChannelInboundTurn).returns.toEqualTypeOf<Promise<ChannelTurnResult>>();
});

it("records and dispatches through dispatchInboundReplyWithBase", async () => {
  const recordInboundSession = vi.fn<RecordInboundSession>(async () => undefined);
  const deliver = vi.fn(async () => undefined);
  const dispatch = vi.fn<DispatchReplyWithBufferedBlockDispatcher>(async (params) => {
    await params.dispatcherOptions.deliver(
      { text: "hello", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  await legacy.dispatchInboundReplyWithBase({
    cfg: {},
    channel: "test",
    accountId: "default",
    route: { agentId: "main", sessionKey: "agent:main:test:peer" },
    storePath: `${tempDirs.make("openclaw-inbound-reply-dispatch-")}/sessions.json`,
    ctxPayload: { Body: "body", CommandAuthorized: false },
    core: {
      channel: {
        session: { recordInboundSession },
        reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
      },
    },
    deliver,
    onRecordError: vi.fn(),
    onDispatchError: vi.fn(),
  });

  expect(recordInboundSession).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledWith({
    text: "hello",
    mediaUrls: ["https://example.com/a.png"],
  });
});

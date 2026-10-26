import { expect, it, vi } from "vitest";
import {
  resolveAndApplyOutboundReplyToId as applyReply,
  resolveAndApplyOutboundThreadId as applyThread,
} from "./message-action-threading.js";

type ReplyContext = Parameters<typeof applyReply>[1];
const current = {
  currentChannelId: "channel:C123",
  currentMessageId: "msg-42",
  replyToMode: "all",
} as const;
const replyContext = { channel: "workspace", toolContext: current } satisfies ReplyContext;
const slackContext = {
  channel: "slack",
  toolContext: { ...current, currentChannelId: "D123", currentMessagingTarget: "user:U123" },
} satisfies ReplyContext;

it("skips auto-threading for an explicit null threadId", () => {
  const resolveAutoThreadId = vi.fn(() => "42");
  const toolContext = { currentChannelId: "forum:123", currentThreadTs: "42" };
  const context = { cfg: {}, to: "forum:123", toolContext, resolveAutoThreadId };
  expect(applyThread({ threadId: null }, context)).toBeUndefined();
  expect(resolveAutoThreadId).not.toHaveBeenCalled();
});

it("inherits replies for routable target aliases", () => {
  const params: Record<string, unknown> = { to: "user:U123" };
  expect(applyReply(params, slackContext)).toEqual({
    replyToId: "msg-42",
    source: "implicit",
    mode: "all",
  });
  expect(params.replyTo).toBe("msg-42");
});

it.each(["top-level", "cross-provider"])("does not inherit replies for %s sends", (mode) => {
  const params: Record<string, unknown> = {
    target: "channel:C123",
    topLevel: mode === "top-level",
  };
  const context =
    mode === "top-level"
      ? replyContext
      : {
          channel: "discord",
          toolContext: { ...current, currentChannelProvider: "slack" },
        };
  expect(applyReply(params, context)).toBeUndefined();
  expect(params.replyTo).toBeUndefined();
});

it.each(["batched", "first"] as const)("consumes %s reply mode once", (mode) => {
  const hasRepliedRef = { value: false };
  const batched = mode === "batched";
  const base = batched ? slackContext : replyContext;
  const matchesToolContextTarget = vi.fn(({ target }: { target: string }) => target === "U123");
  const context: ReplyContext = {
    ...base,
    toolContext: { ...base.toolContext, replyToMode: mode, hasRepliedRef },
    ...(batched ? { matchesToolContextTarget } : {}),
  };
  const params: Record<string, unknown> = batched ? { target: "U123" } : { replyTo: "explicit-1" };
  expect(applyReply(params, context)).toEqual(
    batched
      ? { replyToId: "msg-42", source: "implicit", mode: "first" }
      : { replyToId: "explicit-1", source: "explicit" },
  );
  if (batched) {
    expect(params.replyTo).toBe("msg-42");
  }
  expect(applyReply({ target: batched ? "U123" : "channel:C123" }, context)).toBeUndefined();
  expect(hasRepliedRef.value).toBe(true);
  if (batched) {
    expect(matchesToolContextTarget).toHaveBeenCalledTimes(2);
  }
});

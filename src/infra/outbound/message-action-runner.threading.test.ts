import { describe, expect, it, vi } from "vitest";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundReplyToId,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const threadContext = {
  cfg: {},
  to: "forum:123",
  toolContext: { currentChannelId: "forum:123", currentThreadTs: "42" },
};
const replyContext = {
  channel: "workspace",
  toolContext: {
    currentChannelId: "channel:C123",
    currentMessageId: "msg-42",
    replyToMode: "all",
  },
} satisfies Parameters<typeof resolveAndApplyOutboundReplyToId>[1];

describe("message action threading helpers", () => {
  it("mirrors an inherited reply through its canonical root", async () => {
    const actionParams: Record<string, unknown> = { replyTo: "child-777" };
    const sessionKey = "agent:main:forum:channel:123:thread:root-42";
    const resolveOutboundSessionRoute = vi
      .fn<Parameters<typeof prepareOutboundMirrorRoute>[0]["resolveOutboundSessionRoute"]>()
      .mockResolvedValue({
        sessionKey,
        baseSessionKey: "base",
        peer: { id: "123", kind: "channel" },
        chatType: "channel",
        from: "forum:123",
        to: "forum:123",
        threadId: "root-42",
      });

    const result = await prepareOutboundMirrorRoute({
      ...threadContext,
      channel: "forum",
      actionParams,
      agentId: "main",
      replyToIsExplicit: false,
      resolveAutoThreadId: ({ replyToId }) => (replyToId ? undefined : "root-42"),
      resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit }) => ({
        replyToId: replyToIsExplicit || threadId == null ? replyToId : String(threadId),
        threadId: threadId ?? null,
      }),
      resolveOutboundSessionRoute,
    });

    expect(resolveOutboundSessionRoute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ replyToId: "root-42", threadId: "root-42" }),
    );
    expect(result.outboundRoute?.sessionKey).toBe(sessionKey);
    expect(actionParams).toEqual({
      replyTo: "root-42",
      threadId: "root-42",
      __sessionKey: sessionKey,
      __agentId: "main",
    });
  });

  it("preserves explicit replies through Slack-style transport", () => {
    const actionParams: Record<string, unknown> = {
      threadId: "root-42",
      replyTo: "child-777",
    };
    const resolveAutoThreadId = vi.fn(() => "unexpected");
    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      ...threadContext,
      resolveAutoThreadId,
      replyToIsExplicit: true,
      resolveReplyTransport: ({ replyToId }) => ({ replyToId, threadId: null }),
    });

    expect(actionParams).toEqual({ threadId: "root-42", replyTo: "child-777" });
    expect(resolved).toBe("root-42");
    expect(resolveAutoThreadId).not.toHaveBeenCalled();
  });

  it("skips auto-threading for an explicit null threadId", () => {
    const resolveAutoThreadId = vi.fn(() => "42");
    const resolved = resolveAndApplyOutboundThreadId(
      { threadId: null },
      { ...threadContext, resolveAutoThreadId },
    );

    expect(resolved).toBeUndefined();
    expect(resolveAutoThreadId).not.toHaveBeenCalled();
  });

  it("keeps reply and thread distinct without canonicalization", () => {
    const resolveAutoThreadId = vi.fn(() => "thread-777");
    const actionParams: Record<string, unknown> = { replyTo: "777" };
    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      ...threadContext,
      resolveAutoThreadId,
    });

    expect(resolveAutoThreadId).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ replyToId: "777" }),
    );
    expect(resolved).toBe("thread-777");
    expect(actionParams).toEqual({ threadId: "thread-777", replyTo: "777" });
  });

  it("inherits replies for routable target aliases", () => {
    const actionParams: Record<string, unknown> = { to: "user:U123" };
    const resolved = resolveAndApplyOutboundReplyToId(actionParams, {
      channel: "slack",
      toolContext: {
        ...replyContext.toolContext,
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
      },
    });

    expect(resolved).toEqual({ replyToId: "msg-42", source: "implicit", mode: "all" });
    expect(actionParams.replyTo).toBe("msg-42");
  });

  it("skips inherited reply ids for explicit top-level sends", () => {
    const actionParams: Record<string, unknown> = { target: "channel:C123", topLevel: true };
    expect(resolveAndApplyOutboundReplyToId(actionParams, replyContext)).toBeUndefined();
    expect(actionParams.replyTo).toBeUndefined();
  });

  it("consumes batched replies once for normalized aliases", () => {
    const hasRepliedRef = { value: false };
    const matchesToolContextTarget = vi.fn(({ target }: { target: string }) => target === "U123");
    const context = {
      channel: "slack",
      toolContext: {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentMessageId: "msg-42",
        replyToMode: "batched",
        hasRepliedRef,
      },
      matchesToolContextTarget,
    } satisfies Parameters<typeof resolveAndApplyOutboundReplyToId>[1];
    const actionParams: Record<string, unknown> = { target: "U123" };

    expect(resolveAndApplyOutboundReplyToId(actionParams, context)).toEqual({
      replyToId: "msg-42",
      source: "implicit",
      mode: "first",
    });
    expect(actionParams.replyTo).toBe("msg-42");
    expect(resolveAndApplyOutboundReplyToId({ target: "U123" }, context)).toBeUndefined();
    expect(hasRepliedRef.value).toBe(true);
    expect(matchesToolContextTarget).toHaveBeenCalledTimes(2);
  });

  it("consumes first-mode for explicit replies", () => {
    const hasRepliedRef = { value: false };
    const context = {
      ...replyContext,
      toolContext: { ...replyContext.toolContext, replyToMode: "first", hasRepliedRef },
    } satisfies Parameters<typeof resolveAndApplyOutboundReplyToId>[1];

    expect(resolveAndApplyOutboundReplyToId({ replyTo: "explicit-1" }, context)).toEqual({
      replyToId: "explicit-1",
      source: "explicit",
    });
    expect(resolveAndApplyOutboundReplyToId({ target: "channel:C123" }, context)).toBeUndefined();
    expect(hasRepliedRef.value).toBe(true);
  });

  it("isolates replies across providers with matching target IDs", () => {
    const actionParams: Record<string, unknown> = { target: "channel:C123" };
    const resolved = resolveAndApplyOutboundReplyToId(actionParams, {
      channel: "discord",
      toolContext: { ...replyContext.toolContext, currentChannelProvider: "slack" },
    });

    expect(resolved).toBeUndefined();
    expect(actionParams.replyTo).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { FollowupRun } from "./queue/types.js";
import {
  buildRecentSentReplyRootKey,
  buildRecentSentReplyRootKeyForRun,
  resolveReplyRootFromContext,
  resolveReplyRootId,
  resolveReplyRootIdFromContext,
} from "./reply-root-dedupe.js";

describe("resolveReplyRootId", () => {
  it("prefers explicit reply targets before thread roots", () => {
    expect(
      resolveReplyRootId({
        rootMessageId: "thread-root",
        replyToId: "reply-target",
        messageId: "current-message",
      }),
    ).toBe("reply-target");
  });

  it("falls back to the thread root when reply-to metadata is unavailable", () => {
    expect(
      resolveReplyRootId({
        rootMessageId: "thread-root",
        messageId: "current-message",
      }),
    ).toBe("thread-root");
  });
});

describe("resolveReplyRootIdFromContext", () => {
  it("prefers ReplyToIdFull before RootMessageId", () => {
    expect(
      resolveReplyRootIdFromContext({
        RootMessageId: "thread-root",
        ReplyToId: "reply-short",
        ReplyToIdFull: "reply-full",
        MessageSid: "message-short",
        MessageSidFull: "message-full",
      }),
    ).toBe("reply-full");
  });

  it("tracks when the reply root came from a thread root fallback", () => {
    expect(
      resolveReplyRootFromContext({
        RootMessageId: "thread-root",
        MessageSid: "message-short",
      }),
    ).toEqual({ id: "thread-root", source: "thread-root" });
  });
});

describe("reply-root dedupe keys", () => {
  it("does not create sent-root keys for thread-root fallbacks", () => {
    expect(
      buildRecentSentReplyRootKey({
        scopeKey: "main",
        agentId: "agent",
        channel: "discord",
        to: "channel:C1",
        replyRootId: "thread-root",
        replyRootSource: "thread-root",
      }),
    ).toBeUndefined();
  });

  it("normalizes channel ids consistently between route and followup paths", () => {
    const runKey = buildRecentSentReplyRootKeyForRun({
      originatingChannel: "Slack",
      originatingTo: "channel:C1",
      originatingAccountId: "work",
      originatingThreadId: "t-1",
      replyRootId: "root-1",
      replyRootSource: "reply-to",
      run: {
        agentId: "agent",
        sessionId: "session",
        sessionKey: "main",
      },
    } as Pick<
      FollowupRun,
      | "originatingChannel"
      | "originatingTo"
      | "originatingAccountId"
      | "originatingThreadId"
      | "replyRootId"
      | "replyRootSource"
      | "run"
    >);
    const routeKey = buildRecentSentReplyRootKey({
      scopeKey: "main",
      agentId: "agent",
      channel: "slack",
      to: "channel:C1",
      accountId: "work",
      threadId: "t-1",
      replyRootId: "root-1",
      replyRootSource: "reply-to",
    });

    expect(runKey).toBe(routeKey);
  });
});

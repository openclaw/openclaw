import { afterEach, describe, expect, it } from "vitest";
import { cacheTopicName, clearTopicCache } from "../topic-cache.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  normalizeForwardedContext,
  resolveTelegramForumThreadId,
} from "./helpers.js";

describe("buildTelegramGroupPeerId", () => {
  afterEach(() => {
    clearTopicCache();
  });

  it("returns chat ID as string when no topic", () => {
    expect(buildTelegramGroupPeerId(-1003856094222)).toBe("-1003856094222");
    expect(buildTelegramGroupPeerId("-1003856094222")).toBe("-1003856094222");
  });

  it("returns chat:topic:id format when topic provided without name", () => {
    expect(buildTelegramGroupPeerId(-1003856094222, 49)).toBe("-1003856094222:topic:49");
  });

  it("appends slugified topic name when provided", () => {
    expect(buildTelegramGroupPeerId(-1003856094222, 49, "Telegram Ops")).toBe(
      "-1003856094222:topic:49-telegram-ops",
    );
  });

  it("uses cached topic name when not explicitly provided", () => {
    cacheTopicName(-1003856094222, 49, "Cached Topic Name");
    expect(buildTelegramGroupPeerId(-1003856094222, 49)).toBe(
      "-1003856094222:topic:49-cached-topic-name",
    );
  });

  it("prefers explicit topic name over cached name", () => {
    cacheTopicName(-1003856094222, 49, "Cached Name");
    expect(buildTelegramGroupPeerId(-1003856094222, 49, "Explicit Name")).toBe(
      "-1003856094222:topic:49-explicit-name",
    );
  });

  it("falls back to id-only format when slug is empty", () => {
    // Topic name with only special characters produces empty slug
    expect(buildTelegramGroupPeerId(-1003856094222, 49, "🎉🎊🎁")).toBe("-1003856094222:topic:49");
  });

  it("handles General topic (id=1)", () => {
    cacheTopicName(-1003856094222, 1, "General");
    expect(buildTelegramGroupPeerId(-1003856094222, 1)).toBe("-1003856094222:topic:1-general");
  });
});

describe("resolveTelegramForumThreadId", () => {
  it("returns undefined for non-forum groups even with messageThreadId", () => {
    // Reply threads in regular groups should not create separate sessions
    expect(resolveTelegramForumThreadId({ isForum: false, messageThreadId: 42 })).toBeUndefined();
  });

  it("returns undefined for non-forum groups without messageThreadId", () => {
    expect(
      resolveTelegramForumThreadId({ isForum: false, messageThreadId: undefined }),
    ).toBeUndefined();
    expect(
      resolveTelegramForumThreadId({ isForum: undefined, messageThreadId: 99 }),
    ).toBeUndefined();
  });

  it("returns General topic (1) for forum groups without messageThreadId", () => {
    expect(resolveTelegramForumThreadId({ isForum: true, messageThreadId: undefined })).toBe(1);
    expect(resolveTelegramForumThreadId({ isForum: true, messageThreadId: null })).toBe(1);
  });

  it("returns the topic id for forum groups with messageThreadId", () => {
    expect(resolveTelegramForumThreadId({ isForum: true, messageThreadId: 99 })).toBe(99);
  });
});

describe("buildTelegramThreadParams", () => {
  it("omits General topic thread id for message sends", () => {
    expect(buildTelegramThreadParams(1)).toBeUndefined();
  });

  it("includes non-General topic thread ids", () => {
    expect(buildTelegramThreadParams(99)).toEqual({ message_thread_id: 99 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTelegramThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});

describe("buildTypingThreadParams", () => {
  it("returns undefined when no thread id is provided", () => {
    expect(buildTypingThreadParams(undefined)).toBeUndefined();
  });

  it("includes General topic thread id for typing indicators", () => {
    expect(buildTypingThreadParams(1)).toEqual({ message_thread_id: 1 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTypingThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});

describe("normalizeForwardedContext", () => {
  it("handles forward_origin users", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "user",
        sender_user: { first_name: "Ada", last_name: "Lovelace", username: "ada", id: 42 },
        date: 123,
      },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Ada Lovelace (@ada)");
    expect(ctx?.fromType).toBe("user");
    expect(ctx?.fromId).toBe("42");
    expect(ctx?.fromUsername).toBe("ada");
    expect(ctx?.fromTitle).toBe("Ada Lovelace");
    expect(ctx?.date).toBe(123);
  });

  it("handles hidden forward_origin names", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: { type: "hidden_user", sender_user_name: "Hidden Name", date: 456 },
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Hidden Name");
    expect(ctx?.fromType).toBe("hidden_user");
    expect(ctx?.fromTitle).toBe("Hidden Name");
    expect(ctx?.date).toBe(456);
  });

  it("handles legacy forwards with signatures", () => {
    const ctx = normalizeForwardedContext({
      forward_from_chat: {
        title: "OpenClaw Updates",
        username: "openclaw",
        id: 99,
        type: "channel",
      },
      forward_signature: "Stan",
      forward_date: 789,
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("OpenClaw Updates (Stan)");
    expect(ctx?.fromType).toBe("legacy_channel");
    expect(ctx?.fromId).toBe("99");
    expect(ctx?.fromUsername).toBe("openclaw");
    expect(ctx?.fromTitle).toBe("OpenClaw Updates");
    expect(ctx?.fromSignature).toBe("Stan");
    expect(ctx?.date).toBe(789);
  });

  it("handles legacy hidden sender names", () => {
    const ctx = normalizeForwardedContext({
      forward_sender_name: "Legacy Hidden",
      forward_date: 111,
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Legacy Hidden");
    expect(ctx?.fromType).toBe("legacy_hidden_user");
    expect(ctx?.date).toBe(111);
  });
});

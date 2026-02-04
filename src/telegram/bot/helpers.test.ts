import { describe, expect, it } from "vitest";
import {
  buildTelegramThreadParams,
  buildTypingThreadParams,
  expandTextLinks,
  normalizeForwardedContext,
  resolveTelegramForumThreadId,
} from "./helpers.js";

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
    expect(buildTelegramThreadParams({ id: 1, scope: "forum" })).toBeUndefined();
  });

  it("includes non-General topic thread ids", () => {
    expect(buildTelegramThreadParams({ id: 99, scope: "forum" })).toEqual({
      message_thread_id: 99,
    });
  });

  it("keeps thread id=1 for dm threads", () => {
    expect(buildTelegramThreadParams({ id: 1, scope: "dm" })).toEqual({
      message_thread_id: 1,
    });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTelegramThreadParams({ id: 42.9, scope: "forum" })).toEqual({
      message_thread_id: 42,
    });
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
      // oxlint-disable-next-line typescript/no-explicit-any
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
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Hidden Name");
    expect(ctx?.fromType).toBe("hidden_user");
    expect(ctx?.fromTitle).toBe("Hidden Name");
    expect(ctx?.date).toBe(456);
  });
});

describe("expandTextLinks", () => {
  it("returns text unchanged when no entities are provided", () => {
    expect(expandTextLinks("Hello world")).toBe("Hello world");
    expect(expandTextLinks("Hello world", null)).toBe("Hello world");
    expect(expandTextLinks("Hello world", [])).toBe("Hello world");
  });

  it("returns text unchanged when there are no text_link entities", () => {
    const entities = [
      { type: "mention", offset: 0, length: 5 },
      { type: "bold", offset: 6, length: 5 },
    ];
    expect(expandTextLinks("@user hello", entities)).toBe("@user hello");
  });

  it("expands a single text_link entity", () => {
    const text = "Check this link for details";
    const entities = [{ type: "text_link", offset: 11, length: 4, url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(
      "Check this [link](https://example.com) for details",
    );
  });

  it("expands multiple text_link entities", () => {
    const text = "Visit Google or GitHub for more";
    const entities = [
      { type: "text_link", offset: 6, length: 6, url: "https://google.com" },
      { type: "text_link", offset: 16, length: 6, url: "https://github.com" },
    ];
    expect(expandTextLinks(text, entities)).toBe(
      "Visit [Google](https://google.com) or [GitHub](https://github.com) for more",
    );
  });

  it("handles adjacent text_link entities", () => {
    const text = "AB";
    const entities = [
      { type: "text_link", offset: 0, length: 1, url: "https://a.example" },
      { type: "text_link", offset: 1, length: 1, url: "https://b.example" },
    ];
    expect(expandTextLinks(text, entities)).toBe("[A](https://a.example)[B](https://b.example)");
  });

  it("preserves offsets from the original string", () => {
    const text = " Hello world";
    const entities = [{ type: "text_link", offset: 1, length: 5, url: "https://example.com" }];
    expect(expandTextLinks(text, entities)).toBe(" [Hello](https://example.com) world");
  });
});

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

  it("skips thread id for dm threads (DMs don't have threads)", () => {
    expect(buildTelegramThreadParams({ id: 1, scope: "dm" })).toBeUndefined();
    expect(buildTelegramThreadParams({ id: 2, scope: "dm" })).toBeUndefined();
  });

  it("normalizes and skips thread id for dm threads even with edge values", () => {
    expect(buildTelegramThreadParams({ id: 0, scope: "dm" })).toBeUndefined();
    expect(buildTelegramThreadParams({ id: -1, scope: "dm" })).toBeUndefined();
    expect(buildTelegramThreadParams({ id: 1.9, scope: "dm" })).toBeUndefined();
  });

  it("handles thread id 0 for non-dm scopes", () => {
    // id=0 should be included for forum and none scopes (not falsy)
    expect(buildTelegramThreadParams({ id: 0, scope: "forum" })).toEqual({
      message_thread_id: 0,
    });
    expect(buildTelegramThreadParams({ id: 0, scope: "none" })).toEqual({
      message_thread_id: 0,
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

  it("handles forward_origin channel with author_signature and message_id", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: {
          title: "Tech News",
          username: "technews",
          id: -1001234,
          type: "channel",
        },
        date: 500,
        author_signature: "Editor",
        message_id: 42,
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Tech News (Editor)");
    expect(ctx?.fromType).toBe("channel");
    expect(ctx?.fromId).toBe("-1001234");
    expect(ctx?.fromUsername).toBe("technews");
    expect(ctx?.fromTitle).toBe("Tech News");
    expect(ctx?.fromSignature).toBe("Editor");
    expect(ctx?.fromChatType).toBe("channel");
    expect(ctx?.fromMessageId).toBe(42);
    expect(ctx?.date).toBe(500);
  });

  it("handles forward_origin chat with sender_chat and author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "chat",
        sender_chat: {
          title: "Discussion Group",
          id: -1005678,
          type: "supergroup",
        },
        date: 600,
        author_signature: "Admin",
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("Discussion Group (Admin)");
    expect(ctx?.fromType).toBe("chat");
    expect(ctx?.fromId).toBe("-1005678");
    expect(ctx?.fromTitle).toBe("Discussion Group");
    expect(ctx?.fromSignature).toBe("Admin");
    expect(ctx?.fromChatType).toBe("supergroup");
    expect(ctx?.date).toBe(600);
  });

  it("uses author_signature from forward_origin", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "My Channel", id: -100999, type: "channel" },
        date: 700,
        author_signature: "New Sig",
        message_id: 1,
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.fromSignature).toBe("New Sig");
    expect(ctx?.from).toBe("My Channel (New Sig)");
  });

  it("returns undefined signature when author_signature is blank", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "Updates", id: -100333, type: "channel" },
        date: 860,
        author_signature: "   ",
        message_id: 1,
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.from).toBe("Updates");
  });

  it("handles forward_origin channel without author_signature", () => {
    const ctx = normalizeForwardedContext({
      forward_origin: {
        type: "channel",
        chat: { title: "News", id: -100111, type: "channel" },
        date: 900,
        message_id: 1,
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.from).toBe("News");
    expect(ctx?.fromSignature).toBeUndefined();
    expect(ctx?.fromChatType).toBe("channel");
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

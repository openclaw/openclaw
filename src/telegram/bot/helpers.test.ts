import { describe, expect, it } from "vitest";
import {
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  expandTextLinks,
  normalizeForwardedContext,
  resolveTelegramForumThreadId,
} from "./helpers.js";

describe("resolveTelegramForumThreadId", () => {
  it.each([
    { isForum: false, messageThreadId: 42 },
    { isForum: false, messageThreadId: undefined },
    { isForum: undefined, messageThreadId: 99 },
  ])("returns undefined for non-forum groups", (params) => {
    // Reply threads in regular groups should not create separate sessions.
    expect(resolveTelegramForumThreadId(params)).toBeUndefined();
  });

  it.each([
    { isForum: true, messageThreadId: undefined, expected: 1 },
    { isForum: true, messageThreadId: null, expected: 1 },
    { isForum: true, messageThreadId: 99, expected: 99 },
  ])("resolves forum topic ids", ({ expected, ...params }) => {
    expect(resolveTelegramForumThreadId(params)).toBe(expected);
  });
});

describe("buildTelegramThreadParams", () => {
  it.each([
    { input: { id: 1, scope: "forum" as const }, expected: undefined },
    { input: { id: 99, scope: "forum" as const }, expected: { message_thread_id: 99 } },
    { input: { id: 1, scope: "dm" as const }, expected: { message_thread_id: 1 } },
    { input: { id: 2, scope: "dm" as const }, expected: { message_thread_id: 2 } },
    { input: { id: 0, scope: "dm" as const }, expected: undefined },
    { input: { id: -1, scope: "dm" as const }, expected: undefined },
    { input: { id: 1.9, scope: "dm" as const }, expected: { message_thread_id: 1 } },
    // id=0 should be included for forum and none scopes (not falsy)
    { input: { id: 0, scope: "forum" as const }, expected: { message_thread_id: 0 } },
    { input: { id: 0, scope: "none" as const }, expected: { message_thread_id: 0 } },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
  });
});

describe("buildTypingThreadParams", () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: 1, expected: { message_thread_id: 1 } },
  ])("builds typing params", ({ input, expected }) => {
    expect(buildTypingThreadParams(input)).toEqual(expected);
  });
});

describe("thread id normalization", () => {
  it.each([
    {
      build: () => buildTelegramThreadParams({ id: 42.9, scope: "forum" }),
      expected: { message_thread_id: 42 },
    },
    {
      build: () => buildTypingThreadParams(42.9),
      expected: { message_thread_id: 42 },
    },
  ])("normalizes thread ids to integers", ({ build, expected }) => {
    expect(build()).toEqual(expected);
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

describe("describeReplyTarget", () => {
  it("returns null when no reply_to_message", () => {
    const result = describeReplyTarget(
      // oxlint-disable-next-line typescript/no-explicit-any
      { message_id: 1, date: 1000, chat: { id: 1, type: "private" } } as any,
    );
    expect(result).toBeNull();
  });

  it("extracts basic reply info", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        text: "Original message",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("Original message");
    expect(result?.sender).toBe("Alice");
    expect(result?.id).toBe("1");
    expect(result?.kind).toBe("reply");
  });

  it("extracts forwarded context from reply_to_message (issue #9619)", () => {
    // When user forwards a message with a comment, the comment message has
    // reply_to_message pointing to the forwarded message. We should extract
    // the forward_origin from the reply target.
    const result = describeReplyTarget({
      message_id: 3,
      date: 1100,
      chat: { id: 1, type: "private" },
      text: "Here is my comment about this forwarded content",
      reply_to_message: {
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private" },
        text: "This is the forwarded content",
        forward_origin: {
          type: "user",
          sender_user: {
            id: 999,
            first_name: "Bob",
            last_name: "Smith",
            username: "bobsmith",
            is_bot: false,
          },
          date: 500,
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("This is the forwarded content");
    expect(result?.id).toBe("2");
    // The reply target's forwarded context should be included
    expect(result?.forwardedFrom).toBeDefined();
    expect(result?.forwardedFrom?.from).toBe("Bob Smith (@bobsmith)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("999");
    expect(result?.forwardedFrom?.date).toBe(500);
  });

  it("extracts forwarded context from channel forward in reply_to_message", () => {
    const result = describeReplyTarget({
      message_id: 4,
      date: 1200,
      chat: { id: 1, type: "private" },
      text: "Interesting article!",
      reply_to_message: {
        message_id: 3,
        date: 1100,
        chat: { id: 1, type: "private" },
        text: "Channel post content here",
        forward_origin: {
          type: "channel",
          chat: { id: -1001234567, title: "Tech News", username: "technews", type: "channel" },
          date: 800,
          message_id: 456,
          author_signature: "Editor",
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(result).not.toBeNull();
    expect(result?.forwardedFrom).toBeDefined();
    expect(result?.forwardedFrom?.from).toBe("Tech News (Editor)");
    expect(result?.forwardedFrom?.fromType).toBe("channel");
    expect(result?.forwardedFrom?.fromMessageId).toBe(456);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = describeReplyTarget({
      message_id: 5,
      date: 1300,
      chat: { id: 1, type: "private" },
      text: "Comment on forwarded message",
      external_reply: {
        message_id: 4,
        date: 1200,
        chat: { id: 1, type: "private" },
        text: "Forwarded from elsewhere",
        forward_origin: {
          type: "user",
          sender_user: {
            id: 123,
            first_name: "Eve",
            last_name: "Stone",
            username: "eve",
            is_bot: false,
          },
          date: 700,
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("4");
    expect(result?.forwardedFrom?.from).toBe("Eve Stone (@eve)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("123");
    expect(result?.forwardedFrom?.date).toBe(700);
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

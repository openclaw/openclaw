import { describe, expect, it } from "vitest";
import { GroupChatSchema, VisibleRepliesSchema } from "./zod-schema.core.js";
import { MessagesSchema } from "./zod-schema.session.js";

describe("VisibleRepliesSchema", () => {
  it('accepts "automatic"', () => {
    expect(VisibleRepliesSchema.parse("automatic")).toBe("automatic");
  });

  it('accepts "message_tool"', () => {
    expect(VisibleRepliesSchema.parse("message_tool")).toBe("message_tool");
  });

  it("coerces boolean true to automatic", () => {
    expect(VisibleRepliesSchema.parse(true)).toBe("automatic");
  });

  it("coerces boolean false to message_tool", () => {
    expect(VisibleRepliesSchema.parse(false)).toBe("message_tool");
  });

  it("accepts undefined (optional)", () => {
    expect(VisibleRepliesSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects an invalid string", () => {
    expect(() => VisibleRepliesSchema.parse("always")).toThrow();
  });
});

describe("GroupChatSchema — visibleReplies coercion", () => {
  it("coerces boolean true to automatic inside groupChat config", () => {
    const result = GroupChatSchema.parse({ visibleReplies: true });
    expect(result?.visibleReplies).toBe("automatic");
  });

  it("coerces boolean false to message_tool inside groupChat config", () => {
    const result = GroupChatSchema.parse({ visibleReplies: false });
    expect(result?.visibleReplies).toBe("message_tool");
  });
});

describe("MessagesSchema — visibleReplies coercion", () => {
  it("coerces boolean true at messages.visibleReplies", () => {
    const result = MessagesSchema.parse({ visibleReplies: true });
    expect(result?.visibleReplies).toBe("automatic");
  });

  it("coerces boolean true at messages.groupChat.visibleReplies", () => {
    const result = MessagesSchema.parse({ groupChat: { visibleReplies: true } });
    expect(result?.groupChat?.visibleReplies).toBe("automatic");
  });
});

import { describe, expect, it } from "vitest";
import { resolveReactionMessageId } from "./reaction-message-id.js";

describe("resolveReactionMessageId", () => {
  it("uses explicit messageId when present", () => {
    const result = resolveReactionMessageId({
      args: { messageId: "456" },
      toolContext: { currentMessageId: "123" },
    });
    expect(result).toBe("456");
  });

  it("accepts snake_case message_id alias", () => {
    const result = resolveReactionMessageId({ args: { message_id: "789" } });
    expect(result).toBe("789");
  });

  it("falls back to toolContext.currentMessageId", () => {
    const result = resolveReactionMessageId({
      args: {},
      toolContext: { currentMessageId: "9001" },
    });
    expect(result).toBe("9001");
  });

  it("strips synthetic :reaction: suffix from message ID", () => {
    const result = resolveReactionMessageId({
      args: { messageId: "om_abc123:reaction:THUMBSUP:550e8400-e29b-41d4-a716-446655440000" },
    });
    expect(result).toBe("om_abc123");
  });

  it("strips :reaction: suffix from toolContext.currentMessageId", () => {
    const result = resolveReactionMessageId({
      args: {},
      toolContext: { currentMessageId: "om_xyz:reaction:HEART:deadbeef" },
    });
    expect(result).toBe("om_xyz");
  });

  it("leaves normal message IDs unchanged", () => {
    const result = resolveReactionMessageId({ args: { messageId: "om_normal456" } });
    expect(result).toBe("om_normal456");
  });

  it("preserves numeric message IDs (coerced to string by readStringOrNumberParam)", () => {
    const result = resolveReactionMessageId({ args: { messageId: 12345 } });
    expect(result).toBe("12345");
  });
});

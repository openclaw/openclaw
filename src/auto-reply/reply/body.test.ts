import { describe, expect, it } from "vitest";

import { applySessionHints } from "./body.js";

describe("applySessionHints", () => {
  it("appends message_id hint by default", async () => {
    const result = await applySessionHints({
      baseBody: "hello",
      abortedLastRun: false,
      messageId: "msg-123",
    });
    expect(result).toContain("[message_id: msg-123]");
  });

  it("appends message_id hint when includeIds is true", async () => {
    const result = await applySessionHints({
      baseBody: "hello",
      abortedLastRun: false,
      messageId: "msg-123",
      includeIds: true,
    });
    expect(result).toContain("[message_id: msg-123]");
  });

  it("suppresses message_id hint when includeIds is false", async () => {
    const result = await applySessionHints({
      baseBody: "hello",
      abortedLastRun: false,
      messageId: "msg-123",
      includeIds: false,
    });
    expect(result).not.toContain("[message_id:");
    expect(result).toBe("hello");
  });

  it("omits message_id hint when messageId is empty", async () => {
    const result = await applySessionHints({
      baseBody: "hello",
      abortedLastRun: false,
      messageId: "  ",
    });
    expect(result).not.toContain("[message_id:");
  });
});

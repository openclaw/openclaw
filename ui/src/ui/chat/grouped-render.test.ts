import { nothing } from "lit";
import { describe, expect, it } from "vitest";
import { renderGroupedMessage } from "./grouped-render.ts";

describe("renderGroupedMessage", () => {
  it("returns nothing when message text is NO_REPLY", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("returns nothing when streaming message text is NO_REPLY", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: true, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("returns nothing when message text contains NO_REPLY with whitespace", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "  NO_REPLY  " }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("returns nothing when message text has NO_REPLY at start", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY (system message)" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("renders normally when message has actual content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello, world!" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).not.toBe(nothing);
  });

  it("returns nothing when message has empty content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("returns nothing when message has only whitespace", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "   " }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  // Word boundary tests - ensure we don't incorrectly suppress valid messages
  it("renders normally when NO_REPLY is part of a word (prefix)", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLYx should render" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).not.toBe(nothing);
  });

  it("renders normally when NO_REPLY is part of a word (suffix)", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "This is xNO_REPLY" }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).not.toBe(nothing);
  });

  it("returns nothing when NO_REPLY is followed by punctuation", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY." }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });

  it("returns nothing when NO_REPLY ends with trailing whitespace and punctuation", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Some text NO_REPLY  " }],
      timestamp: Date.now(),
    };
    const result = renderGroupedMessage(message, { isStreaming: false, showReasoning: false });
    expect(result).toBe(nothing);
  });
});

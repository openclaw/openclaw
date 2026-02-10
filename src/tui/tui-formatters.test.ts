import { describe, expect, it } from "vitest";
import {
  extractContentFromMessage,
  extractTextFromMessage,
  extractThinkingFromMessage,
  isCommandMessage,
  sanitizeForDisplay,
} from "./tui-formatters.js";

describe("extractTextFromMessage", () => {
  it("renders errorMessage when assistant content is empty", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\\u0027s rate limit. Please try again later."},"request_id":"req_123"}',
    });

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("req_123");
  });

  it("falls back to a generic message when errorMessage is missing", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "",
    });

    expect(text).toContain("unknown error");
  });

  it("joins multiple text blocks with single newlines", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    expect(text).toBe("first\nsecond");
  });

  it("places thinking before content when included", () => {
    const text = extractTextFromMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "ponder" },
        ],
      },
      { includeThinking: true },
    );

    expect(text).toBe("[thinking]\nponder\n\nhello");
  });
});

describe("extractThinkingFromMessage", () => {
  it("collects only thinking blocks", () => {
    const text = extractThinkingFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alpha" },
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "beta" },
      ],
    });

    expect(text).toBe("alpha\nbeta");
  });

  it("strips binary data from thinking blocks", () => {
    const text = extractThinkingFromMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "thought\x00\x01\x80process" }],
    });

    expect(text).toBe("thoughtprocess");
  });
});

describe("extractContentFromMessage", () => {
  it("collects only text blocks", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alpha" },
        { type: "text", text: "hello" },
      ],
    });

    expect(text).toBe("hello");
  });

  it("renders error text when stopReason is error and content is not an array", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: '429 {"error":{"message":"rate limit"}}',
    });

    expect(text).toContain("HTTP 429");
  });
});

describe("sanitizeForDisplay", () => {
  it("strips control characters from text", () => {
    // Simulate binary data that leaked into a text field
    const binaryText = "hello\x00\x01\x02\x03\x04\x05\x06\x07\x08world";
    const result = sanitizeForDisplay(binaryText);
    expect(result).toBe("helloworld");
  });

  it("strips C1 control codes (0x80-0x9F)", () => {
    const c1Text = "data\x80\x81\x8F\x9Fmore";
    const result = sanitizeForDisplay(c1Text);
    expect(result).toBe("datamore");
  });

  it("strips DELETE character (0x7F)", () => {
    const text = "before\x7Fafter";
    const result = sanitizeForDisplay(text);
    expect(result).toBe("beforeafter");
  });

  it("preserves normal whitespace (newline, tab, carriage return)", () => {
    const text = "line1\nline2\ttabbed\rcarriage";
    const result = sanitizeForDisplay(text);
    expect(result).toBe("line1\nline2\ttabbed\rcarriage");
  });

  it("preserves Unicode printable characters", () => {
    const text = "café résumé 日本語 한국어 Привет";
    const result = sanitizeForDisplay(text);
    expect(result).toBe("café résumé 日本語 한국어 Привет");
  });

  it("returns empty string for purely binary content", () => {
    // Simulate raw PDF header bytes as a string
    const binary = String.fromCharCode(0x00, 0x01, 0x02, 0x80, 0x90, 0x9f, 0x7f);
    const result = sanitizeForDisplay(binary);
    expect(result).toBe("");
  });
});

describe("extractTextFromMessage — binary sanitization", () => {
  it("strips binary data from text content blocks", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: [{ type: "text", text: "hello\x00\x01\x02 world\x80\x9F" }],
    });
    expect(text).toBe("hello world");
  });

  it("strips binary data from string content", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: "message\x00\x01with\x7Fbinary",
    });
    expect(text).toBe("messagewithbinary");
  });
});

describe("extractContentFromMessage — binary sanitization", () => {
  it("strips binary data from text content blocks", () => {
    const text = extractContentFromMessage({
      role: "assistant",
      content: [{ type: "text", text: "response\x00\x03\x80data" }],
    });
    expect(text).toBe("responsedata");
  });
});

describe("isCommandMessage", () => {
  it("detects command-marked messages", () => {
    expect(isCommandMessage({ command: true })).toBe(true);
    expect(isCommandMessage({ command: false })).toBe(false);
    expect(isCommandMessage({})).toBe(false);
  });
});

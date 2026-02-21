import { describe, expect, it } from "vitest";
import {
  extractContentFromMessage,
  extractTextFromMessage,
  extractThinkingFromMessage,
  isCommandMessage,
  sanitizeRenderableText,
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

  it("preserves internal newlines for string content", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: "Line 1\nLine 2\nLine 3",
    });

    expect(text).toBe("Line 1\nLine 2\nLine 3");
  });

  it("preserves internal newlines for text blocks", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
    });

    expect(text).toBe("Line 1\nLine 2\nLine 3");
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

  it("sanitizes ANSI and control chars from string content", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: "Hello\x1b[31m red\x1b[0m\x00world",
    });

    expect(text).toBe("Hello redworld");
  });

  it("redacts heavily corrupted binary-like lines", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [{ type: "text", text: "������������������������" }],
    });

    expect(text).toBe("[binary data omitted]");
  });

  it("strips leading inbound metadata blocks for user messages", () => {
    const text = extractTextFromMessage({
      role: "user",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "abc123"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "Someone"
}
\`\`\`

Actual user message`,
    });

    expect(text).toBe("Actual user message");
  });

  it("keeps metadata-like blocks for non-user messages", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"abc123"}
\`\`\`

Assistant body`,
    });

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).toContain("Assistant body");
  });

  it("does not strip metadata-like blocks that are not a leading prefix", () => {
    const text = extractTextFromMessage({
      role: "user",
      content:
        'Hello world\nConversation info (untrusted metadata):\n```json\n{"message_id":"123"}\n```\n\nFollow-up',
    });

    expect(text).toBe(
      'Hello world\nConversation info (untrusted metadata):\n```json\n{"message_id":"123"}\n```\n\nFollow-up',
    );
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

describe("isCommandMessage", () => {
  it("detects command-marked messages", () => {
    expect(isCommandMessage({ command: true })).toBe(true);
    expect(isCommandMessage({ command: false })).toBe(false);
    expect(isCommandMessage({})).toBe(false);
  });
});

describe("sanitizeRenderableText", () => {
  it("breaks very long unbroken tokens to avoid overflow", () => {
    const input = "a".repeat(140);
    const sanitized = sanitizeRenderableText(input);
    const longestSegment = Math.max(...sanitized.split(/\s+/).map((segment) => segment.length));

    expect(longestSegment).toBeLessThanOrEqual(32);
  });

  it("breaks moderately long unbroken tokens to protect narrow terminals", () => {
    const input = "b".repeat(90);
    const sanitized = sanitizeRenderableText(input);
    const longestSegment = Math.max(...sanitized.split(/\s+/).map((segment) => segment.length));

    expect(longestSegment).toBeLessThanOrEqual(32);
  });

  it("preserves long filesystem paths verbatim for copy safety", () => {
    const input =
      "/Users/jasonshawn/PerfectXiao/a_very_long_directory_name_designed_specifically_to_test_the_line_wrapping_issue/file.txt";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long urls verbatim for copy safety", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/remain/contiguous/when/rendered";
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix".repeat(2);
    const sanitized = sanitizeRenderableText(input);

    expect(sanitized).toBe(input);
  });
});

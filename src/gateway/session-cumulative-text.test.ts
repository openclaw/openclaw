import { describe, expect, it } from "vitest";
import {
  createCumulativeTextStripper,
  stripCumulativeAssistantText,
  messageContentHasToolUse,
  extractMessageTextContent,
} from "./session-cumulative-text.js";

describe("stripCumulativeAssistantText", () => {
  it("strips duplicated prefix from post-tool-call assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking google..." },
          { type: "toolUse", id: "t1", name: "browser" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "200 OK" },
      {
        role: "assistant",
        content: [{ type: "text", text: "checking google...ok it opens" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    const lastMsg = result[2] as Record<string, unknown>;
    const content = lastMsg.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("ok it opens");
  });

  it("handles chained tool calls across multiple rounds", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "A" },
          { type: "toolUse", id: "t1", name: "tool1" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "r1" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "AB" },
          { type: "toolUse", id: "t2", name: "tool2" },
        ],
      },
      { role: "toolResult", toolCallId: "t2", content: "r2" },
      {
        role: "assistant",
        content: [{ type: "text", text: "ABC" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    // Round 2: "AB" → stripped to "B"
    const msg2 = result[2] as Record<string, unknown>;
    const content2 = msg2.content as Array<{ type: string; text?: string }>;
    const textBlock2 = content2.find((b) => b.type === "text");
    expect(textBlock2?.text).toBe("B");

    // Round 3: "ABC" → stripped to "C"
    const msg4 = result[4] as Record<string, unknown>;
    const content4 = msg4.content as Array<{ type: string; text?: string }>;
    expect(content4[0].text).toBe("C");
  });

  it("does not strip when text does not start with prior prefix", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking..." },
          { type: "toolUse", id: "t1", name: "browser" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "result" },
      {
        role: "assistant",
        content: [{ type: "text", text: "something completely different" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    const lastMsg = result[2] as Record<string, unknown>;
    const content = lastMsg.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("something completely different");
  });

  it("resets tracking on a real user message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first turn" },
          { type: "toolUse", id: "t1", name: "tool1" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "r1" },
      { role: "user", content: [{ type: "text", text: "new question" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "first turn and more" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    // After the user message, tracking resets. The assistant text should NOT be stripped
    // even though it starts with "first turn".
    const lastMsg = result[3] as Record<string, unknown>;
    const content = lastMsg.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("first turn and more");
  });

  it("does not reset tracking on tool_result user messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolUse", id: "t1", name: "browser" },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "let me check...done" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    const lastMsg = result[2] as Record<string, unknown>;
    const content = lastMsg.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("...done");
  });

  it("handles empty text gracefully", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "t1", name: "browser" }],
      },
      { role: "toolResult", toolCallId: "t1", content: "ok" },
      {
        role: "assistant",
        content: [{ type: "text", text: "result is ok" }],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    // First message has no text, so nothing to strip from the second
    const lastMsg = result[2] as Record<string, unknown>;
    const content = lastMsg.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("result is ok");
  });

  it("preserves non-text content blocks after stripping", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "step 1" },
          { type: "toolUse", id: "t1", name: "tool1" },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "r1" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "step 1 step 2" },
          { type: "toolUse", id: "t2", name: "tool2" },
        ],
      },
    ];

    const result = stripCumulativeAssistantText(messages);
    const msg = result[2] as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: " step 2" });
    expect(content[1]).toEqual({ type: "toolUse", id: "t2", name: "tool2" });
  });

  it("handles all tool_use type variants", () => {
    for (const toolType of ["toolUse", "toolCall", "tool_use", "tool_call", "functionCall"]) {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "prefix" },
            { type: toolType, id: "t1", name: "tool" },
          ],
        },
        { role: "toolResult", toolCallId: "t1", content: "r" },
        {
          role: "assistant",
          content: [{ type: "text", text: "prefix suffix" }],
        },
      ];

      const result = stripCumulativeAssistantText(messages);
      const lastMsg = result[2] as Record<string, unknown>;
      const content = lastMsg.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe(" suffix");
    }
  });
});

describe("createCumulativeTextStripper", () => {
  it("returns a stateful processor function", () => {
    const process = createCumulativeTextStripper();
    expect(typeof process).toBe("function");
  });

  it("passes through non-object messages", () => {
    const process = createCumulativeTextStripper();
    expect(process(null)).toBeNull();
    expect(process("string")).toBe("string");
    expect(process(42)).toBe(42);
  });

  it("passes through non-assistant messages unchanged", () => {
    const process = createCumulativeTextStripper();
    const userMsg = { role: "user", content: [{ type: "text", text: "hello" }] };
    expect(process(userMsg)).toBe(userMsg);
  });
});

describe("messageContentHasToolUse", () => {
  it("detects tool_use content blocks", () => {
    expect(messageContentHasToolUse([{ type: "toolUse", id: "t1", name: "x" }])).toBe(true);
    expect(messageContentHasToolUse([{ type: "text", text: "hello" }])).toBe(false);
    expect(messageContentHasToolUse("not an array")).toBe(false);
  });
});

describe("extractMessageTextContent", () => {
  it("extracts concatenated text from content blocks", () => {
    expect(
      extractMessageTextContent([
        { type: "text", text: "hello " },
        { type: "toolUse", id: "t1" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("returns empty string for non-array content", () => {
    expect(extractMessageTextContent("not an array")).toBe("");
    expect(extractMessageTextContent(undefined)).toBe("");
  });
});

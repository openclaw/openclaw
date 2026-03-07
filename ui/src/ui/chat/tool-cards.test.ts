import { describe, it, expect } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  it("extracts tool result text from nested content array", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: [{ type: "text", text: "command output here" }],
        },
      ],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("result");
    expect(cards[0].text).toBe("command output here");
  });

  it("extracts tool result text from string content", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: "plain string output",
        },
      ],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("plain string output");
  });

  it("extracts tool result text from text field", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          text: "text field output",
        },
      ],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("text field output");
  });

  it("handles tool message with role=tool and toolCallId", () => {
    const message = {
      role: "tool",
      tool_call_id: "call_abc",
      toolName: "exec",
      content: [{ type: "text", text: "ls output" }],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("result");
    expect(cards[0].text).toBe("ls output");
    expect(cards[0].name).toBe("exec");
  });

  it("extracts tool calls", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("call");
    expect(cards[0].name).toBe("bash");
  });

  it("returns empty array for non-tool messages", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    };
    expect(extractToolCards(message)).toHaveLength(0);
  });

  it("joins multiple text parts in nested content array", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      ],
    };
    const cards = extractToolCards(message);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("line 1\nline 2");
  });
});

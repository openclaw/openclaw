import { describe, it, expect, vi } from "vitest";
import {
  normalizeContextMessages,
  buildOpenAITools,
  safeJsonParse,
} from "./tool-protocol";

describe("normalizeContextMessages", () => {
  it("should convert toolResult to tool message", () => {
    const input = [
      {
        role: "toolResult",
        toolCallId: "123",
        content: { a: 1 },
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0]).toEqual({
      role: "tool",
      tool_call_id: "123",
      content: JSON.stringify({ a: 1 }),
    });
  });

  it("should fallback tool_call_id when missing", () => {
    const input = [
      {
        role: "toolResult",
        content: "ok",
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toMatch(/^tool_/);
    expect(result[0].content).toBe("ok");
  });

  it("should pass assistant tool_calls correctly", () => {
    const input = [
      {
        role: "assistant",
        content: "hi",
        tool_calls: [{ id: "1" }],
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0]).toEqual({
      role: "assistant",
      content: "hi",
      tool_calls: [{ id: "1" }],
    });
  });

  it("should support toolCalls alias", () => {
    const input = [
      {
        role: "assistant",
        toolCalls: [{ id: "1" }],
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0].tool_calls).toEqual([{ id: "1" }]);
  });

  it("should convert non-string content array to text", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0]).toEqual({
      role: "user",
      content: "hello\nworld",
    });
  });

  it("should ignore non-text content types", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "image", url: "x" },
          { type: "text", text: "ok" },
        ],
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0].content).toBe("\nok");
  });

  it("should pass through string content unchanged", () => {
    const input = [
      {
        role: "user",
        content: "plain text",
      },
    ];

    const result = normalizeContextMessages(input);

    expect(result[0]).toEqual({
      role: "user",
      content: "plain text",
    });
  });
});

describe("buildOpenAITools", () => {
  it("should map tools correctly", () => {
    const tools = [
      {
        name: "test",
        description: "desc",
        parameters: { type: "object", properties: { a: { type: "string" } } },
      },
    ];

    const result = buildOpenAITools(tools);

    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "test",
          description: "desc",
          parameters: tools[0].parameters,
        },
      },
    ]);
  });

  it("should fallback description and parameters", () => {
    const tools = [{ name: "test" }];

    const result = buildOpenAITools(tools);

    expect(result[0].function.description).toBe("");
    expect(result[0].function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("safeJsonParse", () => {
  it("should parse valid JSON string", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it("should return object as-is", () => {
    const obj = { a: 1 };
    expect(safeJsonParse(obj)).toBe(obj);
  });

  it("should return empty object for null/undefined", () => {
    expect(safeJsonParse(null)).toEqual({});
    expect(safeJsonParse(undefined)).toEqual({});
  });

  it("should return empty object for non-string non-object", () => {
    expect(safeJsonParse(123)).toEqual({});
    expect(safeJsonParse(true)).toEqual({});
  });

  it("should recover from malformed JSON with trim", () => {
    expect(safeJsonParse('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("should return empty object on completely invalid JSON", () => {
    expect(safeJsonParse("INVALID")).toEqual({});
  });
});
import { describe, expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks,
  type ToolPayloadCarrier,
} from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("returns undefined for missing results", () => {
    expect(extractToolPayload(undefined)).toBeUndefined();
    expect(extractToolPayload(null)).toBeUndefined();
  });

  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        details: { ok: true },
        content: [{ type: "text", text: '{"ignored":true}' }],
      }),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks and falls back to raw text, content, or the whole result", () => {
    expect(
      extractToolPayload({
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: '{"ok":true,"count":2}' },
        ],
      }),
    ).toEqual({ ok: true, count: 2 });

    expect(
      extractToolPayload({
        content: [{ type: "text", text: "not json" }],
      }),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      }),
    ).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it("parses bracket-style tool call blocks", () => {
    const text = '[read]\n{"path":"/a/b.ts","line_start":1}\n[/read]';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("read");
    expect(result![0].arguments).toEqual({ path: "/a/b.ts", line_start: 1 });
  });

  it("parses harmony-format tool calls (plain channel keyword)", () => {
    const text = 'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("read");
    expect(result![0].arguments).toEqual({
      path: "/path/to/file",
      line_start: 1,
      line_end: 400,
    });
  });

  it("parses harmony-format with <|channel|> delimiter", () => {
    const text = '<|channel|>commentary to=read code<|message|>{"path":"/path/to/file"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("read");
    expect(result![0].arguments).toEqual({ path: "/path/to/file" });
  });

  it("parses harmony-format with analysis channel", () => {
    const text = 'analysis to=exec code {"command":"ls -la"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("exec");
    expect(result![0].arguments).toEqual({ command: "ls -la" });
  });

  it("parses harmony-format with final channel", () => {
    const text = 'final to=write code {"path":"/tmp/out.txt","content":"hello"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("write");
  });

  it("consumes optional trailing <|end|> delimiter", () => {
    const text = 'commentary to=read code {"path":"/file"}<|end|>';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("read");
  });

  it("returns null for malformed harmony (missing to=)", () => {
    const text = 'commentary read code {"path":"/file"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).toBeNull();
  });

  it("returns null for malformed harmony (missing code keyword)", () => {
    const text = 'commentary to=read {"path":"/file"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).toBeNull();
  });

  it("returns null for unknown channel keyword", () => {
    const text = 'unknown to=read code {"path":"/file"}';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(parseStandalonePlainTextToolCallBlocks("")).toBeNull();
    expect(parseStandalonePlainTextToolCallBlocks("   ")).toBeNull();
  });

  it("respects allowedToolNames for harmony blocks", () => {
    const text = 'commentary to=read code {"path":"/file"}';
    const result = parseStandalonePlainTextToolCallBlocks(text, {
      allowedToolNames: new Set(["exec"]),
    });
    expect(result).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  containsPlainTextToolCallOpening,
  couldStillBePlainTextToolCallPrefix,
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
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

describe("parseStandalonePlainTextToolCallBlocks — bracket format", () => {
  it("parses a single bracket-style block with named closing", () => {
    const text = '[exec]\n{"command":"ls"}\n[/exec]';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({
      name: "exec",
      arguments: { command: "ls" },
    });
  });

  it("parses a bracket-style block with [END_TOOL_REQUEST] closing", () => {
    const text = '[exec]\n{"command":"pwd"}\n[END_TOOL_REQUEST]';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.name).toBe("exec");
  });

  it("returns null when bracket block has no closing tag", () => {
    const text = '[exec]\n{"command":"ls"}';
    expect(parseStandalonePlainTextToolCallBlocks(text)).toBeNull();
  });

  it("respects allowedToolNames", () => {
    const text = '[exec]\n{"command":"ls"}\n[/exec]';
    expect(parseStandalonePlainTextToolCallBlocks(text, { allowedToolNames: ["edit"] })).toBeNull();
    expect(
      parseStandalonePlainTextToolCallBlocks(text, { allowedToolNames: ["exec"] }),
    ).not.toBeNull();
  });

  it("parses multiple bracket-style blocks in sequence", () => {
    const text = '[exec]\n{"command":"ls"}\n[/exec]\n[read]\n{"path":"/tmp/x"}\n[/read]';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]?.name).toBe("exec");
    expect(blocks?.[1]?.name).toBe("read");
  });
});

describe("parseStandalonePlainTextToolCallBlocks — harmony format", () => {
  // Background: gpt-oss-120b is trained on OpenAI's "Harmony" chat format. When
  // an inference server's chat-template wrapping fails to translate the model's
  // tool-call output back into structured `tool_calls`, the harmony commentary
  // syntax leaks through as plain assistant text. We've observed this on
  // LM Studio for heavy-context agentic dispatches. The parser should recover
  // the call so the agent can still execute it.

  it("parses harmony commentary opening without channel delimiters", () => {
    const text = 'commentary to=exec code {"command":"ls"}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({
      name: "exec",
      arguments: { command: "ls" },
    });
  });

  it("parses full harmony form with <|channel|> and <|message|> delimiters", () => {
    const text = '<|channel|>commentary to=exec code<|message|>{"command":"ls"}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.name).toBe("exec");
  });

  it("strips functions. prefix from harmony tool names", () => {
    const text = 'commentary to=functions.exec code {"command":"ls"}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.[0]?.name).toBe("exec");
  });

  it("recognizes analysis-channel harmony openings", () => {
    const text = 'analysis to=read code {"path":"/tmp/x"}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks?.[0]?.name).toBe("read");
  });

  it("recognizes final-channel harmony openings", () => {
    const text = 'final to=edit code {"path":"a","old_text":"b","new_text":"c"}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks?.[0]?.name).toBe("edit");
  });

  it("consumes a trailing <|end|> delimiter when present", () => {
    const text = 'commentary to=exec code {"command":"ls"}<|end|>';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    // The block should consume the trailing delimiter so iteration advances cleanly.
    expect(blocks?.[0]?.end).toBe(text.length);
  });

  it("requires a JSON object payload after the harmony opening", () => {
    expect(parseStandalonePlainTextToolCallBlocks("commentary to=exec code")).toBeNull();
    expect(parseStandalonePlainTextToolCallBlocks("commentary to=exec code not-json")).toBeNull();
  });

  it("respects allowedToolNames for harmony-format calls", () => {
    const text = 'commentary to=exec code {"command":"ls"}';
    expect(parseStandalonePlainTextToolCallBlocks(text, { allowedToolNames: ["edit"] })).toBeNull();
    expect(
      parseStandalonePlainTextToolCallBlocks(text, { allowedToolNames: ["exec"] }),
    ).not.toBeNull();
  });

  it("parses real gpt-oss-120b output observed in the wild (read tool)", () => {
    // Captured from LM Studio + gpt-oss-120b on a heavy QA agent dispatch.
    const text =
      'commentary to=read code {"path":"/Users/kain/qa-experiment-sandbox/workdir/tests/services/refreshTokenService.test.ts","line_start":1,"line_end":400}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.[0]).toMatchObject({
      name: "read",
      arguments: {
        path: "/Users/kain/qa-experiment-sandbox/workdir/tests/services/refreshTokenService.test.ts",
        line_start: 1,
        line_end: 400,
      },
    });
  });

  it("handles harmony JSON spread across multiple lines", () => {
    const text = 'commentary to=exec code {\n  "command": "ls -la /tmp"\n}';
    const blocks = parseStandalonePlainTextToolCallBlocks(text);
    expect(blocks?.[0]?.name).toBe("exec");
    expect(blocks?.[0]?.arguments).toEqual({ command: "ls -la /tmp" });
  });
});

describe("parseStandalonePlainTextToolCallBlocks — backward compatibility", () => {
  it("does not match generic prose without a tool-call shape", () => {
    expect(parseStandalonePlainTextToolCallBlocks("hello world")).toBeNull();
    expect(parseStandalonePlainTextToolCallBlocks("[not a tool] some prose")).toBeNull();
  });

  it("does not match an unrelated 'to=' string outside the harmony shape", () => {
    expect(
      parseStandalonePlainTextToolCallBlocks("Sending message to=alice content..."),
    ).toBeNull();
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it("returns text unchanged when no tool-call opening is present", () => {
    expect(stripPlainTextToolCallBlocks("hello world")).toBe("hello world");
  });

  it("strips bracket-style tool-call blocks (leaving surrounding whitespace untouched)", () => {
    const text = 'before\n[exec]\n{"command":"ls"}\n[/exec]\nafter';
    expect(stripPlainTextToolCallBlocks(text)).toBe("before\n\nafter");
  });

  it("strips a harmony-format tool-call block from persisted text", () => {
    const text = 'before\ncommentary to=exec code {"command":"ls"}\nafter';
    expect(stripPlainTextToolCallBlocks(text)).toBe("before\n\nafter");
  });

  it("strips a delimited harmony-format block (was previously short-circuited by the bracket-only regex)", () => {
    const text =
      'preamble\n<|channel|>commentary to=read code<|message|>{"path":"/tmp/x"}<|end|>\ntail';
    expect(stripPlainTextToolCallBlocks(text)).toBe("preamble\n\ntail");
  });
});

describe("containsPlainTextToolCallOpening", () => {
  it("returns false for empty or non-tool-call text", () => {
    expect(containsPlainTextToolCallOpening("")).toBe(false);
    expect(containsPlainTextToolCallOpening("hello world")).toBe(false);
  });

  it("returns true for bracket-style openings", () => {
    expect(containsPlainTextToolCallOpening("[exec]\n{}\n[/exec]")).toBe(true);
  });

  it("returns true for bare-channel harmony openings", () => {
    expect(containsPlainTextToolCallOpening('commentary to=exec code {"command":"ls"}')).toBe(true);
    expect(containsPlainTextToolCallOpening('analysis to=read code {"path":"/x"}')).toBe(true);
  });

  it("returns true for delimited harmony openings", () => {
    expect(
      containsPlainTextToolCallOpening("<|channel|>commentary to=exec code<|message|>{}"),
    ).toBe(true);
  });

  it("does not match unrelated 'to=' usage in prose", () => {
    expect(containsPlainTextToolCallOpening("Sending message to=alice tomorrow")).toBe(false);
  });
});

describe("couldStillBePlainTextToolCallPrefix", () => {
  it("returns true for empty or whitespace-only buffers (might still become a tool call)", () => {
    expect(couldStillBePlainTextToolCallPrefix("")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("   ")).toBe(true);
  });

  it("returns true for bracket-style prefixes (preserves existing behavior)", () => {
    expect(couldStillBePlainTextToolCallPrefix("[")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("[exec]")).toBe(true);
  });

  it("returns true for harmony channel-keyword prefixes (the new behavior)", () => {
    expect(couldStillBePlainTextToolCallPrefix("commentary")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("commentary to=exec code {")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("analysis to=read")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("final to=edit")).toBe(true);
  });

  it("returns true for delimited harmony prefixes", () => {
    expect(couldStillBePlainTextToolCallPrefix("<|")).toBe(true);
    expect(couldStillBePlainTextToolCallPrefix("<|channel|>commentary to=exec")).toBe(true);
  });

  it("returns false for ordinary prose that does not look like a tool-call prefix", () => {
    expect(couldStillBePlainTextToolCallPrefix("hello world")).toBe(false);
    expect(couldStillBePlainTextToolCallPrefix("The answer is 42.")).toBe(false);
  });

  it("returns false when the buffered text exceeds the max payload size", () => {
    expect(
      couldStillBePlainTextToolCallPrefix("[" + "x".repeat(300_000), { maxPayloadBytes: 1000 }),
    ).toBe(false);
  });

  it("does not falsely match bare channel words used as ordinary nouns", () => {
    // The keyword must be at the START of the (trimmed) buffer.  Mid-sentence
    // mentions of the channel word should not buffer.
    expect(couldStillBePlainTextToolCallPrefix("My commentary on this is")).toBe(false);
  });
});

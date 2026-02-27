import { describe, expect, it } from "vitest";
import { extractSessionText, ingestSessionToMemory } from "./session-ingest.js";

describe("extractSessionText", () => {
  it("extracts plain user and assistant string messages", () => {
    const result = extractSessionText([
      { role: "system", content: "do not index" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);

    expect(result).toEqual([
      { role: "user", text: "hello", index: 1 },
      { role: "assistant", text: "hi there", index: 2 },
    ]);
  });

  it("extracts only text blocks from mixed content arrays", () => {
    const result = extractSessionText([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", image: "..." },
          { type: "tool_use", name: "search" },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_result", text: "ignored" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "first\nsecond", index: 0 },
      { role: "assistant", text: "answer", index: 1 },
    ]);
  });

  it("skips system and non user/assistant roles", () => {
    const result = extractSessionText([
      { role: "system", content: "system" },
      { role: "tool", content: "tool output" },
      { role: "user", content: "kept" },
    ]);

    expect(result).toEqual([{ role: "user", text: "kept", index: 2 }]);
  });

  it("skips assistant tool-call-shaped text", () => {
    const result = extractSessionText([
      {
        role: "assistant",
        content: '{"type":"tool_use","name":"memory_search","input":{"q":"x"}}',
      },
      { role: "assistant", content: "normal answer" },
    ]);

    expect(result).toEqual([{ role: "assistant", text: "normal answer", index: 1 }]);
  });

  it("handles malformed and empty inputs gracefully", () => {
    expect(extractSessionText([])).toEqual([]);
    expect(
      extractSessionText([null, 123, { nope: true }, { role: "user", content: "   " }]),
    ).toEqual([]);
  });
});

describe("ingestSessionToMemory", () => {
  it("returns 0 chunks when workspace and config are unavailable", async () => {
    const result = await ingestSessionToMemory({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.chunksWritten).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { parseSlackBlocksInput } from "./blocks-input.js";

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseSlackBlocksInput("{bad-json")).toThrow(/valid JSON/i);
  });

  it("rejects non-array payloads", () => {
    expect(() => parseSlackBlocksInput({ type: "divider" })).toThrow(/must be an array/i);
  });

  it("rejects empty arrays", () => {
    expect(() => parseSlackBlocksInput([])).toThrow(/at least one block/i);
  });

  it("rejects non-object blocks", () => {
    expect(() => parseSlackBlocksInput(["not-a-block"])).toThrow(/must be an object/i);
  });

  it("rejects blocks without type", () => {
    expect(() => parseSlackBlocksInput([{}])).toThrow(/non-empty string type/i);
  });
});

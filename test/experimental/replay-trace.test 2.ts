import { describe, expect, it } from "vitest";
import { parseArgs, parseJsonl } from "../../scripts/experimental/replay-trace.mjs";

describe("replay-trace", () => {
  it("parses args", () => {
    const args = parseArgs(["trace.jsonl", "--strict", "--json"]);
    expect(args.file).toBe("trace.jsonl");
    expect(args.strict).toBe(true);
    expect(args.json).toBe(true);
  });

  it("flags malformed jsonl line numbers", () => {
    const parsed = parseJsonl('{"type":"tool","tool":"exec"}\nnot-json\n{"event":"done"}\n');
    expect(parsed.events).toHaveLength(2);
    expect(parsed.malformed).toEqual([2]);
  });
});

import { describe, expect, it } from "vitest";
import { extractSignals } from "../signal-parser.js";

describe("extractSignals", () => {
  it("parses explicit signal lines only", () => {
    const text = [
      "some text",
      "PHASE_COMPLETE: P2",
      "PHASE_BLOCKED: missing env var",
      "GOAL_COMPLETE",
      "<promise>DONE: shipped</promise>",
    ].join("\n");

    const signals = extractSignals(text);
    expect(signals.map((s) => s.type)).toEqual([
      "phase_complete",
      "phase_blocked",
      "goal_complete",
      "promise_done",
    ]);
  });

  it("ignores instructional text", () => {
    const text = "output exactly PHASE_COMPLETE: P1";
    const signals = extractSignals(text);
    expect(signals).toHaveLength(0);
  });
});

import { expect, onTestFinished, test, vi } from "vitest";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";

test("canonicalizes a session key once without folding opaque peer IDs", () => {
  const key = "AGENT:OPS:SUBAGENT:normalization-work-count";
  const spy = vi.spyOn(String.prototype, "toLowerCase");
  onTestFinished(() => spy.mockRestore());
  expect(canonicalizeSessionKeyForAgent("ignored", key)).toBe(
    "agent:ops:subagent:normalization-work-count",
  );
  expect(spy.mock.contexts.filter((value) => value === key)).toHaveLength(1);
  for (const [raw, expected] of [
    [" GLOBAL ", "global"],
    [" UnKnown ", "unknown"],
    [" Thread-1 ", "agent:ops:thread-1"],
    ["MATRIX:CHANNEL:!AbC:Example.org", "agent:ops:matrix:channel:!AbC:Example.org"],
    ["SIGNAL:GROUP:AbC=", "agent:ops:signal:group:AbC="],
  ] as const) {
    expect(canonicalizeSessionKeyForAgent("OPS", raw)).toBe(expected);
  }
});

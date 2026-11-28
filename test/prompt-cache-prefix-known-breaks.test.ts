// Known prefix breaks must not hide a second change in the same request.
import { describe, expect, it } from "vitest";
import type { WireRequest } from "./helpers/fake-model-transports.js";
import { historyChange, unknownChange } from "./prompt-cache-prefix-randomized.test-support.js";

// Plain words stand for messages; JSON messages pass through unchanged.
const request = (messages: string[], tools: string[] = ["read"]): WireRequest => ({
  system: "rules",
  tools: JSON.stringify(tools.map((name) => ({ name }))),
  messages: messages.map((text) =>
    text.startsWith("{") ? text : JSON.stringify({ role: "user", content: text }),
  ),
  text: "",
});

describe("known prefix breaks", () => {
  it("accepts the opt-out tool addition only when nothing else changed", () => {
    const previous = request(["u1", "a1"]);
    const tools = ["read", "skills_read", "skills_search"];
    expect(unknownChange(previous, request(["u1", "a1", "u2"], tools), false)).toBeUndefined();
    expect(unknownChange(previous, request(["u1-rewritten", "a1", "u2"], tools), false)).toMatch(
      /^message 0:/,
    );
    expect(unknownChange(previous, request(["u1", "a1"], [...tools, "exec"]), false)).toMatch(
      /^tools /,
    );
  });

  it("lets a tool-policy change replace the tools but not rewrite the history", () => {
    const previous = request(["u1", "a1"]);
    const changed = { ...request(["u1", "a1", "u2"], ["read", "web_fetch"]), system: "new" };
    expect(historyChange(previous, changed)).toBeUndefined();
    expect(
      historyChange(previous, { ...changed, messages: request(["u0", "a1", "u2"]).messages }),
    ).toMatch(/^message 0:/);
  });
});

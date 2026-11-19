// Known prefix breaks must not hide a second change in the same request.
import { describe, expect, it } from "vitest";
import type { WireRequest } from "./helpers/fake-model-transports.js";
import { historyChange, unknownChange } from "./prompt-cache-prefix-randomized.test-support.js";
import { KNOWN_BREAKS } from "./prompt-cache-prefix-stability.test-support.js";

// Plain words stand for messages; JSON messages pass through unchanged.
const request = (messages: string[], tools: string[] = ["read"]): WireRequest => ({
  system: "rules",
  tools: JSON.stringify(tools.map((name) => ({ name }))),
  messages: messages.map((text) =>
    text.startsWith("{") ? text : JSON.stringify({ role: "user", content: text }),
  ),
  text: "",
});
const known = (api: string, previous: WireRequest, current: WireRequest) =>
  KNOWN_BREAKS.some((entry) => entry.api === api && entry.accepts(previous, current));

describe("known prefix breaks", () => {
  it("accepts the known tool addition only when nothing else changed", () => {
    const previous = request(["u1", "a1"]);
    const tools = ["read", "skills_read", "skills_search"];
    expect(unknownChange(previous, request(["u1", "a1", "u2"], tools))).toBeUndefined();
    expect(unknownChange(previous, request(["u1-rewritten", "a1", "u2"], tools))).toMatch(
      /^message 0:/,
    );
    expect(unknownChange(previous, request(["u1", "a1"], [...tools, "exec"]))).toMatch(/^tools /);
  });

  it("lets a tool-policy change replace the tools but not rewrite the history", () => {
    const previous = request(["u1", "a1"]);
    const changed = { ...request(["u1", "a1", "u2"], ["read", "web_fetch"]), system: "new" };
    expect(historyChange(previous, changed)).toBeUndefined();
    expect(
      historyChange(previous, { ...changed, messages: request(["u0", "a1", "u2"]).messages }),
    ).toMatch(/^message 0:/);
  });

  it("accepts the cron reply merge only when nothing else changed", () => {
    const reply = { role: "assistant", content: [{ type: "text", text: "ok 14" }] };
    const call = { role: "assistant", content: null, tool_calls: [{ id: "c1" }] };
    const merged = JSON.stringify({ ...reply, tool_calls: call.tool_calls });
    const previous = request(["u1", JSON.stringify(reply), JSON.stringify(call), "tool"]);
    expect(known("openai-completions", previous, request(["u1", merged, "tool", "u2"]))).toBe(true);
    expect(known("openai-completions", previous, request(["u0", merged, "tool", "u2"]))).toBe(
      false,
    );
    expect(known("openai-completions", previous, request(["u1", merged, "tool-x", "u2"]))).toBe(
      false,
    );
  });

  it("accepts the Gemini cron reply merge, which also drops the call ids", () => {
    const reply = JSON.stringify({ role: "model", parts: [{ text: "ok 14" }] });
    const call = { functionCall: { name: "exec", args: {}, id: "c1" } };
    const result = (id?: string) =>
      JSON.stringify({
        role: "user",
        parts: [{ functionResponse: { name: "exec", response: {}, ...(id ? { id } : {}) } }],
      });
    const merged = JSON.stringify({
      role: "model",
      parts: [{ text: "ok 14" }, { functionCall: { name: "exec", args: {} } }],
    });
    const previous = request([
      "u1",
      reply,
      JSON.stringify({ role: "model", parts: [call] }),
      result("c1"),
    ]);
    expect(known("google-generative-ai", previous, request(["u1", merged, result(), "u2"]))).toBe(
      true,
    );
    expect(known("google-generative-ai", previous, request(["u0", merged, result(), "u2"]))).toBe(
      false,
    );
  });

  it("accepts the sent tool-result trim only when nothing else changed", () => {
    const result = (output: string, name = "exec") =>
      JSON.stringify({
        role: "user",
        parts: [{ functionResponse: { name, response: { output } } }],
      });
    const notice = "\n[... 180 more characters truncated; rerun with narrower args if needed]";
    const full = result("x".repeat(200));
    const trimmed = result(`${"x".repeat(20)}${notice}`);
    const renamed = result(`${"x".repeat(20)}${notice}`, "read");
    const corrupted = result(`${"y".repeat(20)}${notice}`);
    const previous = request(["u1", full, "a1"]);
    expect(known("google-generative-ai", previous, request(["u1", trimmed, "a1", "u2"]))).toBe(
      true,
    );
    expect(known("google-generative-ai", previous, request(["u0", trimmed, "a1", "u2"]))).toBe(
      false,
    );
    expect(known("google-generative-ai", previous, request(["u1", renamed, "a1", "u2"]))).toBe(
      false,
    );
    expect(known("google-generative-ai", previous, request(["u1", corrupted, "a1", "u2"]))).toBe(
      false,
    );
  });
});

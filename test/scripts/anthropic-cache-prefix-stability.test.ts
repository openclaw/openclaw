import { describe, expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";

const fixture = () => ({
  model: "synthetic-model",
  instructions: "private synthetic system",
  tools: [{ type: "function", name: "read", description: "private tool description" }],
  prompt_cache_key: "private cache affinity",
  input: [{ role: "user", content: "private synthetic transcript" }],
});
const responses = (payload = fixture()) => snapshotProviderPrefix("openai-responses", payload);
const anthropic = (messages: unknown[], extra = {}) =>
  snapshotProviderPrefix("anthropic-messages", { model: "synthetic-claude", messages, ...extra });
const textBlock = (text: string, cached = false) => ({
  type: "text",
  text,
  ...(cached ? { cache_control: { type: "ephemeral" } } : {}),
});
function diagnostic(before: ReturnType<typeof responses>, after: ReturnType<typeof responses>) {
  try {
    assertStableProviderPrefix(before, after, { label: "diagnostic" });
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("provider cache prefix assertion", () => {
  it.each(["system", "tools", "cacheKey", "history[0]"])(
    "identifies a changed %s without disclosing request content",
    (segment) => {
      const before = responses();
      const payload = fixture();
      if (segment === "system") {
        payload.instructions += " changed";
      }
      if (segment === "tools") {
        payload.tools[0]!.description += " changed";
      }
      if (segment === "cacheKey") {
        payload.prompt_cache_key += " changed";
      }
      if (segment === "history[0]") {
        payload.input[0]!.content += " changed";
      }
      const message = diagnostic(before, responses(payload));
      expect(message).toMatch(
        new RegExp(
          `segment=${segment.replace(/[[\]]/g, "\\$&")} previous=[a-f0-9]{64} next=[a-f0-9]{64} path=`,
        ),
      );
      expect(message).not.toContain("private");
      expect(message).toMatch(/leafPrevious=[a-f0-9]{64} leafNext=[a-f0-9]{64} leafBytes=\d+:\d+$/);
      if (segment === "history[0]") {
        expect(message).toContain("path=$.content");
      }
    },
  );

  it("does not disclose arbitrary object keys in field diagnostics", () => {
    const snapshot = (value: string) =>
      snapshotProviderPrefix("openai-responses", {
        ...fixture(),
        tools: [{ "private schema key": { content: value } }],
      });
    const message = diagnostic(snapshot("private old value"), snapshot("private new value"));
    expect(message).toContain("path=$[0].fields[0].content");
    expect(message).not.toContain("private");
  });

  it("accepts appended history but rejects deletion of an earlier item", () => {
    const original = fixture();
    const before = responses(original);
    original.input.push({ role: "assistant", content: "answer" });
    const appended = responses(original);
    expect(() => assertStableProviderPrefix(before, appended, { label: "append" })).not.toThrow();
    expect(() => assertStableProviderPrefix(appended, before, { label: "delete" })).toThrow(
      /segment=history\[1\].* next=absent/,
    );
  });

  it("allows Anthropic breakpoint advancement but rejects a retention change or disappearance", () => {
    const system = { system: [textBlock("instructions", true)] };
    const before = anthropic([{ role: "user", content: [textBlock("history", true)] }], system);
    const next = anthropic(
      [
        { role: "user", content: [textBlock("history")] },
        { role: "assistant", content: [textBlock("answer")] },
        { role: "user", content: [textBlock("next", true)] },
      ],
      system,
    );
    expect(() => assertStableProviderPrefix(before, next, { label: "advance" })).not.toThrow();
    next.breakpoints[0]!.policy = JSON.stringify({ type: "ephemeral", ttl: "1h" });
    expect(() => assertStableProviderPrefix(before, next, { label: "retention" })).toThrow(
      /segment=cacheBreakpoint.policy/,
    );
    next.breakpoints = [];
    expect(() => assertStableProviderPrefix(before, next, { label: "missing" })).toThrow(
      /segment=cacheBreakpoint.policy/,
    );
  });
  it("normalizes Anthropic text shorthand without hiding retained text changes", () => {
    const snapshot = (content: string | Array<{ text: string; type: string }>) =>
      anthropic([{ role: "user", content }]);
    // The release gate sorts provider JSON keys before taking this snapshot.
    const before = snapshot([{ text: "retained text", type: "text" }]);
    const shorthand = snapshot("retained text");
    expect(() =>
      assertStableProviderPrefix(before, shorthand, { label: "shorthand replay" }),
    ).not.toThrow();
    expect(() =>
      assertStableProviderPrefix(shorthand, before, { label: "block replay" }),
    ).not.toThrow();
    const changed = snapshot("changed text");
    expect(() => assertStableProviderPrefix(before, changed, { label: "rewritten text" })).toThrow(
      /segment=history\[0\].*path=\$.block.text/,
    );
  });

  it("preserves every retained item across an explicit history-window boundary", () => {
    const payload = fixture();
    payload.input.push({ role: "user", content: "retained turn" });
    const before = responses(payload);
    payload.input.shift();
    const options = {
      label: "window",
      boundary: { kind: "history-pruning" as const, startIndex: 0, deleteCount: 1 },
    };
    expect(() => assertStableProviderPrefix(before, responses(payload), options)).not.toThrow();
    payload.input[0]!.content += " rewritten";
    expect(() => assertStableProviderPrefix(before, responses(payload), options)).toThrow(
      /segment=history\[0\]/,
    );
  });

  it("rejects a changed earlier breakpoint even when the last one is unchanged", () => {
    const snapshot = anthropic([
      { role: "user", content: [textBlock("first", true), textBlock("second", true)] },
    ]);
    const after = {
      ...snapshot,
      breakpoints: [{ index: 0, policy: "changed" }, snapshot.breakpoints[1]!],
    };
    expect(() => assertStableProviderPrefix(snapshot, after, { label: "retention" })).toThrow(
      /segment=cacheBreakpoint.policy/,
    );
  });
});

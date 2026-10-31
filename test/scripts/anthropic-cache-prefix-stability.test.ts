import { expect, it } from "vitest";
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
const responses = (payload: Partial<ReturnType<typeof fixture>> = {}) =>
  snapshotProviderPrefix("openai-responses", { ...fixture(), ...payload });
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
const stable = (
  before: ReturnType<typeof responses>,
  after: ReturnType<typeof responses>,
  options: Parameters<typeof assertStableProviderPrefix>[2] = { label: "test" },
) => expect(() => assertStableProviderPrefix(before, after, options));

it.each([
  ["system", { instructions: "private changed system" }],
  ["tools", { tools: [{ type: "function", name: "read", description: "private changed tool" }] }],
  ["cacheKey", { prompt_cache_key: "private changed affinity" }],
  ["history[0]", { input: [{ role: "user", content: "private changed transcript" }] }],
] satisfies Array<[string, Partial<ReturnType<typeof fixture>>]>)(
  "identifies a changed %s without disclosing request content",
  (segment, payload) => {
    const message = diagnostic(responses(), responses(payload));
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
  stable(before, appended).not.toThrow();
  stable(appended, before).toThrow(/segment=history\[1\].* next=absent/);
});

it("allows breakpoint advancement, not retention changes or disappearance", () => {
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
  stable(before, next).not.toThrow();
  next.breakpoints[0]!.policy = JSON.stringify({ type: "ephemeral", ttl: "1h" });
  stable(before, next).toThrow(/segment=cacheBreakpoint.policy/);
  next.breakpoints = [];
  stable(before, next).toThrow(/segment=cacheBreakpoint.policy/);
});
it("normalizes Anthropic text shorthand without hiding retained text changes", () => {
  const snapshot = (content: string | Array<{ text: string; type: string }>) =>
    anthropic([{ role: "user", content }]);
  // The release gate sorts provider JSON keys before taking this snapshot.
  const before = snapshot([{ text: "retained text", type: "text" }]);
  const shorthand = snapshot("retained text");
  stable(before, shorthand).not.toThrow();
  stable(shorthand, before).not.toThrow();
  const changed = snapshot("changed text");
  stable(before, changed).toThrow(/segment=history\[0\].*path=\$.block.text/);
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
  stable(before, responses(payload), options).not.toThrow();
  payload.input[0]!.content += " rewritten";
  stable(before, responses(payload), options).toThrow(/segment=history\[0\]/);
});

it("rejects a changed earlier breakpoint even when the last one is unchanged", () => {
  const snapshot = anthropic([
    { role: "user", content: [textBlock("first", true), textBlock("second", true)] },
  ]);
  const after = {
    ...snapshot,
    breakpoints: [{ index: 0, policy: "changed" }, snapshot.breakpoints[1]!],
  };
  stable(snapshot, after).toThrow(/segment=cacheBreakpoint.policy/);
});

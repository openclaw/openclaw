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

describe("provider cache prefix assertion", () => {
  it.each(["system", "tools", "cacheKey", "history[0]"])(
    "identifies a changed %s without disclosing request content",
    (segment) => {
      const before = snapshotProviderPrefix("openai-responses", fixture());
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
      let message = "";
      try {
        assertStableProviderPrefix(before, snapshotProviderPrefix("openai-responses", payload), {
          label: "turn 2",
        });
      } catch (error) {
        message = (error as Error).message;
      }
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
    const before = snapshotProviderPrefix("openai-responses", {
      ...fixture(),
      tools: [{ "private schema key": { content: "private old value" } }],
    });
    const after = snapshotProviderPrefix("openai-responses", {
      ...fixture(),
      tools: [{ "private schema key": { content: "private new value" } }],
    });
    let message = "";
    try {
      assertStableProviderPrefix(before, after, { label: "schema" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("path=$[0].fields[0].content");
    expect(message).not.toContain("private");
  });

  it("accepts appended history but rejects deletion of an earlier item", () => {
    const original = fixture();
    const before = snapshotProviderPrefix("openai-responses", original);
    original.input.push({ role: "assistant", content: "answer" });
    const appended = snapshotProviderPrefix("openai-responses", original);
    expect(() => assertStableProviderPrefix(before, appended, { label: "append" })).not.toThrow();
    expect(() => assertStableProviderPrefix(appended, before, { label: "delete" })).toThrow(
      /segment=history\[1\].* next=absent/,
    );
  });

  it("allows Anthropic breakpoint advancement but rejects a retention change or disappearance", () => {
    const payload = {
      model: "synthetic-claude",
      system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    const before = snapshotProviderPrefix("anthropic-messages", payload);
    const next = snapshotProviderPrefix("anthropic-messages", {
      ...payload,
      messages: [
        { role: "user", content: [{ type: "text", text: "history" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        {
          role: "user",
          content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
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
  it("preserves every retained item across an explicit history-window boundary", () => {
    const payload = fixture();
    payload.input.push({ role: "user", content: "retained turn" });
    const before = snapshotProviderPrefix("openai-responses", payload);
    payload.input.shift();
    const options = {
      label: "window",
      boundary: { kind: "history-pruning" as const, startIndex: 0, deleteCount: 1 },
    };
    expect(() =>
      assertStableProviderPrefix(
        before,
        snapshotProviderPrefix("openai-responses", payload),
        options,
      ),
    ).not.toThrow();
    payload.input[0]!.content += " rewritten";
    expect(() =>
      assertStableProviderPrefix(
        before,
        snapshotProviderPrefix("openai-responses", payload),
        options,
      ),
    ).toThrow(/segment=history\[0\]/);
  });

  it("rejects a changed earlier breakpoint even when the last one is unchanged", () => {
    const snapshot = snapshotProviderPrefix("anthropic-messages", {
      model: "synthetic-claude",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first", cache_control: { type: "ephemeral" } },
            { type: "text", text: "second", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    const after = {
      ...snapshot,
      breakpoints: [{ index: 0, policy: "changed" }, snapshot.breakpoints[1]!],
    };
    expect(() => assertStableProviderPrefix(snapshot, after, { label: "retention" })).toThrow(
      /segment=cacheBreakpoint.policy/,
    );
  });
});

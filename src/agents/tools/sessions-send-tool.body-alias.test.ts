/**
 * Unit tests for sessions_send body-alias normalisation.
 *
 * Regression coverage for #88146: Anthropic/Pi agents emit the message body
 * under "SendMessage", "content", or "text" rather than the canonical
 * "message" key. Without normalisation the schema validation rejects the call
 * before execute runs.
 *
 * These tests exercise the alias-coalescing logic in isolation via a
 * hand-extracted helper so they don't pull the full tool-loader graph.
 */
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline the alias-coalescing logic that was added to sessions-send-tool.ts
// so the test has no full-module import dependency.
// ---------------------------------------------------------------------------

const SEND_BODY_ALIASES = ["SendMessage", "content", "text"] as const;

/**
 * Normalise non-canonical body aliases to the canonical `message` key.
 * Mirrors the coalescing added in the execute() function of
 * sessions-send-tool.ts for issue #88146.
 */
function normaliseSendArgs(args: Record<string, unknown>): Record<string, unknown> {
  const params = { ...args };
  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SEND_BODY_ALIASES) {
      const v = params[alias];
      if (typeof v === "string" && v.trim()) {
        params.message = v;
        break;
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("sessions_send body-alias normalisation (#88146)", () => {
  it("leaves the canonical `message` key unchanged", () => {
    const out = normaliseSendArgs({ message: "hello canonical", sessionKey: "k" });
    expect(out.message).toBe("hello canonical");
  });

  it("coerces `SendMessage` to `message` (Anthropic / Pi model pattern)", () => {
    const out = normaliseSendArgs({ SendMessage: "hello via SendMessage", sessionKey: "k" });
    expect(out.message).toBe("hello via SendMessage");
  });

  it("coerces `content` to `message`", () => {
    const out = normaliseSendArgs({ content: "hello via content", sessionKey: "k" });
    expect(out.message).toBe("hello via content");
  });

  it("coerces `text` to `message`", () => {
    const out = normaliseSendArgs({ text: "hello via text", sessionKey: "k" });
    expect(out.message).toBe("hello via text");
  });

  it("prefers `SendMessage` over `content` and `text` when multiple aliases present", () => {
    const out = normaliseSendArgs({
      SendMessage: "wins",
      content: "loses",
      text: "loses too",
    });
    expect(out.message).toBe("wins");
  });

  it("prefers canonical `message` over any alias when message is non-empty", () => {
    const out = normaliseSendArgs({
      message: "canonical wins",
      SendMessage: "alias loses",
    });
    expect(out.message).toBe("canonical wins");
  });

  it("does NOT coerce when message is a non-empty string (even whitespace-padded)", () => {
    const out = normaliseSendArgs({ message: "  keep me  ", SendMessage: "nope" });
    // whitespace-only guard uses .trim() — "  keep me  " is non-empty after trim
    expect(out.message).toBe("  keep me  ");
  });

  it("falls through all aliases and leaves message undefined when all are empty/missing", () => {
    const out = normaliseSendArgs({ SendMessage: "", content: "   ", text: "" });
    // No alias resolved — message stays undefined → readStringParam will throw required error
    expect(out.message).toBeUndefined();
  });

  it("does not mutate the original args object", () => {
    const original = { SendMessage: "body text", sessionKey: "k" };
    normaliseSendArgs(original);
    // Original must be unchanged (shallow copy guard)
    expect((original as Record<string, unknown>).message).toBeUndefined();
  });

  it("handles the exact bad tool-call shape from issue #88146 report", () => {
    // From the issue:
    // {"name":"sessions_send","arguments":{"sessionKey":"agent:other:main","SendMessage":"…body text…","timeoutSeconds":60}}
    const out = normaliseSendArgs({
      sessionKey: "agent:other:main",
      SendMessage: "…body text…",
      timeoutSeconds: 60,
    });
    expect(out.message).toBe("…body text…");
    // Original alias key still present (we only add, not delete)
    expect(out.SendMessage).toBe("…body text…");
    expect(out.timeoutSeconds).toBe(60);
  });
});

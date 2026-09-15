// Thread-binding message tests cover user-visible names and lifecycle text.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings-messages.js";

describe("thread-binding names", () => {
  it.each([
    { durationMs: -Infinity, label: "disabled" },
    { durationMs: Infinity, label: "disabled" },
    { durationMs: NaN, label: "disabled" },
    { durationMs: -0.1, label: "disabled" },
    { durationMs: -0, label: "disabled" },
    { durationMs: 0.9, label: "disabled" },
    { durationMs: 59_999.9, label: "<1m" },
    { durationMs: 60_000.9, label: "1m" },
    { durationMs: 3_600_000.9, label: "1h" },
  ])("normalizes $durationMs in intro and farewell text", ({ durationMs, label }) => {
    const params = { idleTimeoutMs: durationMs, maxAgeMs: durationMs };
    expect(resolveThreadBindingIntroText({ agentId: "worker", ...params })).toBe(
      label === "disabled"
        ? "⚙️ worker session active. Messages here go directly to this session."
        : `⚙️ worker session active (idle expiry after ${label} inactivity; max age ${label}). Messages here go directly to this session.`,
    );
    expect(resolveThreadBindingFarewellText({ reason: "idle-expired", ...params })).toBe(
      `⚙️ Conversation binding expired after ${label} of inactivity. Messages here will no longer go to that session.`,
    );
    expect(resolveThreadBindingFarewellText({ reason: "max-age-expired", ...params })).toBe(
      `⚙️ Conversation binding expired at max age of ${label}. Messages here will no longer go to that session.`,
    );
  });

  it("includes lifecycle details in intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "main",
      label: "worker",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 48 * 60 * 60 * 1000,
    });

    expect(intro).toContain("idle expiry after 24h inactivity");
    expect(intro).toContain("max age 48h");
  });

  it("places the working directory before session details", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "codex",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      sessionCwd: "/home/bob/clawd",
      sessionDetails: ["session ids: pending (available after the first reply)"],
    });

    expect(intro).toContain("\ncwd: /home/bob/clawd\nsession ids: pending");
  });

  it("does not split surrogate pairs at native name limits", () => {
    const threadName = resolveThreadBindingThreadName({
      label: `${"x".repeat(96)}🚀tail`,
    });
    const intro = resolveThreadBindingIntroText({
      label: `${"x".repeat(99)}🚀tail`,
    });

    expect(threadName).toBe(`🤖 ${"x".repeat(96)}`);
    expect(intro).toContain(`${"x".repeat(99)} session active`);
  });
});

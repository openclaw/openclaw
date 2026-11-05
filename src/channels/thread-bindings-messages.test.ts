// Thread-binding message tests cover user-visible names and lifecycle text.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings-messages.js";

describe("thread-binding names", () => {
  it.each([
    { idle: 0.9, max: 0.9, idleLabel: "disabled", maxLabel: "disabled" },
    { idle: 59_999.9, max: 59_999.9, idleLabel: "<1m", maxLabel: "<1m" },
    { idle: 60_000.9, max: 3_600_000.9, idleLabel: "1m", maxLabel: "1h" },
  ])(
    "normalizes $idle ms idle and $max ms max-age in lifecycle text",
    ({ idle, max, idleLabel, maxLabel }) => {
      const params = { idleTimeoutMs: idle, maxAgeMs: max };
      expect(resolveThreadBindingIntroText({ agentId: "worker", ...params })).toBe(
        idleLabel === "disabled"
          ? "⚙️ worker session active. Messages here go directly to this session."
          : `⚙️ worker session active (idle expiry after ${idleLabel} inactivity; max age ${maxLabel}). Messages here go directly to this session.`,
      );
      expect(resolveThreadBindingFarewellText({ reason: "idle-expired", ...params })).toBe(
        `⚙️ Conversation binding expired after ${idleLabel} of inactivity. Messages here will no longer go to that session.`,
      );
      expect(resolveThreadBindingFarewellText({ reason: "max-age-expired", ...params })).toBe(
        `⚙️ Conversation binding expired at max age of ${maxLabel}. Messages here will no longer go to that session.`,
      );
    },
  );

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

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildBareSessionResetBootstrapPendingPrompt,
  buildBareSessionResetPrompt,
} from "./session-reset-prompt.js";

describe("buildBareSessionResetPrompt", () => {
  it("includes the explicit Session Startup instruction for bare /new and /reset", () => {
    const prompt = buildBareSessionResetPrompt();
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("read the required files before responding to the user");
    expect(prompt).toContain("If bootstrap is still pending for this workspace");
    expect(prompt).toContain("read BOOTSTRAP.md from the workspace");
    expect(prompt).not.toContain(
      "If runtime-provided startup context is included for this first turn",
    );
  });

  it("builds a bootstrap-pending reset prompt that suppresses the normal first greeting", () => {
    const prompt = buildBareSessionResetBootstrapPendingPrompt();
    expect(prompt).toContain("while bootstrap is still pending for this workspace");
    expect(prompt).toContain(
      "Before producing any user-visible reply, you MUST read BOOTSTRAP.md from the workspace now",
    );
    expect(prompt).toContain(
      "Do not greet the user, offer help, answer the message, or reply normally",
    );
    expect(prompt).toContain("Your first user-visible reply must follow BOOTSTRAP.md");
  });

  it("appends current time line so agents know the date", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(cfg, nowMs);
    expect(prompt).toContain(
      "Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York) / 2026-03-03 14:00 UTC",
    );
  });

  it("does not append a duplicate current time line", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("falls back to UTC when no timezone configured", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect(prompt).toContain("Current time:");
  });
});

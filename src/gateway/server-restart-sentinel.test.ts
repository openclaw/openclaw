import { describe, expect, it } from "vitest";
import { resolveRestartAutoContinuePrompt } from "./server-restart-sentinel.js";

describe("restart sentinel auto-continue", () => {
  it("falls back to default prompt when unset", () => {
    const prompt = resolveRestartAutoContinuePrompt({ autoContinuePrompt: undefined });
    expect(prompt).toContain("Gateway restarted");
    expect(prompt).toContain("interrupted task");
  });

  it("falls back to default prompt when blank", () => {
    const prompt = resolveRestartAutoContinuePrompt({ autoContinuePrompt: "   " });
    expect(prompt).toContain("Gateway restarted");
  });

  it("uses explicit prompt when provided", () => {
    const prompt = resolveRestartAutoContinuePrompt({
      autoContinuePrompt: "Please continue where you left off.",
    });
    expect(prompt).toBe("Please continue where you left off.");
  });
});

import { describe, expect, it, vi } from "vitest";

describe("legacy config detection", () => {
  it("rejects root-level aliases with helpful message", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      aliases: {
        "1": "anthropic/claude-opus-4-5",
        "2": "anthropic/claude-sonnet-4-5",
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("aliases");
      expect(res.issues[0]?.message).toContain("no longer supported");
      expect(res.issues[0]?.message).toContain("openclaw models aliases add");
    }
  });
});

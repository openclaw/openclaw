import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("status footer config schema", () => {
  it.each(["off", "minimal", "activity"] as const)("accepts %s mode", (mode) => {
    const result = validateConfigObjectRaw({ messages: { statusFooter: mode } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.messages?.statusFooter).toBe(mode);
    }
  });

  it("accepts per-channel modes with a default", () => {
    const statusFooter = { default: "minimal", telegram: "activity", discord: "off" } as const;
    const result = validateConfigObjectRaw({ messages: { statusFooter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.messages?.statusFooter).toEqual(statusFooter);
    }
  });

  it.each([
    { statusFooter: "on" },
    { statusFooter: { default: "verbose" } },
    { statusFooter: { telegram: true } },
  ])("rejects invalid values: $statusFooter", ({ statusFooter }) => {
    const result = validateConfigObjectRaw({ messages: { statusFooter } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("messages.statusFooter"))).toBe(
        true,
      );
    }
  });
});

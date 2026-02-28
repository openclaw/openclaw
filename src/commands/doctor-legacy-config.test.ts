import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";

describe("normalizeCompatibilityConfigValues preview streaming aliases", () => {
  it("normalizes telegram boolean streaming aliases to enum", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        telegram: {
          streaming: false,
        },
      },
    });

    expect(res.config.channels?.telegram?.streaming).toBe("off");
    expect(res.config.channels?.telegram?.streamMode).toBeUndefined();
    expect(res.changes).toEqual(["Normalized channels.telegram.streaming boolean → enum (off)."]);
  });

  it("normalizes discord boolean streaming aliases to enum", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          streaming: true,
        },
      },
    });

    expect(res.config.channels?.discord?.streaming).toBe("partial");
    expect(res.config.channels?.discord?.streamMode).toBeUndefined();
    expect(res.changes).toEqual([
      "Normalized channels.discord.streaming boolean → enum (partial).",
    ]);
  });
});

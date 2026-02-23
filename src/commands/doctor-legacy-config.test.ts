import { describe, expect, it } from "vitest";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";

describe("normalizeLegacyConfigValues preview streaming aliases", () => {
  it("normalizes telegram boolean streaming aliases to enum", () => {
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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

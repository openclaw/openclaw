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

  it("normalizes slack boolean streaming aliases to enum and native streaming", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        slack: {
          streaming: false,
        },
      },
    });

    expect(res.config.channels?.slack?.streaming).toBe("off");
    expect(res.config.channels?.slack?.nativeStreaming).toBe(false);
    expect(res.config.channels?.slack?.streamMode).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streaming (boolean) → channels.slack.nativeStreaming (false).",
    ]);
  });
});

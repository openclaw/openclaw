import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config discord presence", () => {
  it("accepts status-only presence", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          status: "idle",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts custom activity when type is omitted", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          activity: "Focus time",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts custom activity type", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          activity: "Chilling",
          activityType: 4,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects streaming activity without url", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          activity: "Live",
          activityType: 1,
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects activityUrl without streaming type", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          activity: "Live",
          activityUrl: "https://twitch.tv/openclaw",
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts auto presence config", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          autoPresence: {
            enabled: true,
            intervalMs: 30000,
            minUpdateIntervalMs: 15000,
            exhaustedText: "token exhausted",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects auto presence min update interval above check interval", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          autoPresence: {
            enabled: true,
            intervalMs: 5000,
            minUpdateIntervalMs: 6000,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});

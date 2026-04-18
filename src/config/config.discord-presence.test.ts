import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "./zod-schema.providers-core.js";

describe("config discord presence", () => {
  it.each([
    { name: "status-only presence", config: { discord: { status: "idle" } } },
    {
      name: "custom activity when type is omitted",
      config: { discord: { activity: "Focus time" } },
    },
    {
      name: "custom activity type",
      config: { discord: { activity: "Chilling", activityType: 4 } },
    },
    {
      name: "auto presence config",
      config: {
        discord: {
          autoPresence: {
            enabled: true,
            intervalMs: 30000,
            minUpdateIntervalMs: 15000,
            exhaustedText: "token exhausted",
          },
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config.discord).success).toBe(true);
  });

  it.each([
    {
      name: "streaming activity without url",
      config: { discord: { activity: "Live", activityType: 1 } },
    },
    {
      name: "activityUrl without streaming type",
      config: { discord: { activity: "Live", activityUrl: "https://twitch.tv/openclaw" } },
    },
    {
      name: "auto presence min update interval above check interval",
      config: {
        discord: {
          autoPresence: {
            enabled: true,
            intervalMs: 5000,
            minUpdateIntervalMs: 6000,
          },
        },
      },
    },
  ] as const)("rejects $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config.discord).success).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfigObject } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config discord", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("loads discord guild map + dm group settings", async () => {
    await withTempHomeConfig(
      {
        channels: {
          discord: {
            enabled: true,
            dm: {
              enabled: true,
              allowFrom: ["steipete"],
              groupEnabled: true,
              groupChannels: ["openclaw-dm"],
            },
            actions: {
              emojiUploads: true,
              stickerUploads: false,
              channels: true,
            },
            guilds: {
              "123": {
                slug: "friends-of-openclaw",
                requireMention: false,
                users: ["steipete"],
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      },
      async () => {
        const cfg = loadConfig();

        expect(cfg.channels?.discord?.enabled).toBe(true);
        expect(cfg.channels?.discord?.dm?.groupEnabled).toBe(true);
        expect(cfg.channels?.discord?.dm?.groupChannels).toEqual(["openclaw-dm"]);
        expect(cfg.channels?.discord?.actions?.emojiUploads).toBe(true);
        expect(cfg.channels?.discord?.actions?.stickerUploads).toBe(false);
        expect(cfg.channels?.discord?.actions?.channels).toBe(true);
        expect(cfg.channels?.discord?.guilds?.["123"]?.slug).toBe("friends-of-openclaw");
        expect(cfg.channels?.discord?.guilds?.["123"]?.channels?.general?.allow).toBe(true);
      },
    );
  });

  it("accepts omitMessageMetadata at guild and channel level", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          guilds: {
            "g1": {
              omitMessageMetadata: true,
              channels: {
                "general": { allow: true },
                "dev": { allow: true, omitMessageMetadata: false },
              },
            },
            "g2": {
              channels: {
                "support": { omitMessageMetadata: true },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const guilds = res.config.channels?.discord?.guilds;
    expect(guilds?.["g1"]?.omitMessageMetadata).toBe(true);
    expect(guilds?.["g1"]?.channels?.general?.omitMessageMetadata).toBeUndefined();
    expect(guilds?.["g1"]?.channels?.dev?.omitMessageMetadata).toBe(false);
    expect(guilds?.["g2"]?.channels?.support?.omitMessageMetadata).toBe(true);
  });

  it("rejects numeric discord allowlist entries", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: [456], groupChannels: [789] },
          guilds: {
            "123": {
              users: [111],
              roles: [222],
              channels: {
                general: { users: [333], roles: [444] },
              },
            },
          },
          execApprovals: { approvers: [555] },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((issue) => issue.message.includes("Discord IDs must be strings")),
      ).toBe(true);
    }
  });
});

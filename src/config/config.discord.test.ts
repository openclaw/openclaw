import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";

describe("config discord", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("coerces numeric Discord IDs to strings (Snowflake overflow prevention)", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            channels: {
              discord: {
                enabled: true,
                dm: {
                  enabled: true,
                  // numeric IDs that fit in JS Number (should be coerced to string)
                  allowFrom: [123456789, "steipete"],
                  groupChannels: [987654321],
                },
                guilds: {
                  "111": {
                    users: [42, "admin"],
                    roles: [99],
                    channels: {
                      general: { users: [7], roles: [8] },
                    },
                  },
                },
                execApprovals: {
                  enabled: false,
                  approvers: [12345],
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const cfg = loadConfig();
      const discord = cfg.channels?.discord;

      // DM allowFrom: numeric 123456789 → string "123456789"
      expect(discord?.dm?.allowFrom).toEqual(["123456789", "steipete"]);
      expect(discord?.dm?.groupChannels).toEqual(["987654321"]);

      // Guild users/roles coerced
      const guild = discord?.guilds?.["111"];
      expect(guild?.users).toEqual(["42", "admin"]);
      expect(guild?.roles).toEqual(["99"]);

      // Channel users/roles coerced
      expect(guild?.channels?.general?.users).toEqual(["7"]);
      expect(guild?.channels?.general?.roles).toEqual(["8"]);

      // Exec approvals coerced
      expect(discord?.execApprovals?.approvers).toEqual(["12345"]);
    });
  });

  it("loads discord guild map + dm group settings", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
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
          null,
          2,
        ),
        "utf-8",
      );

      const cfg = loadConfig();

      expect(cfg.channels?.discord?.enabled).toBe(true);
      expect(cfg.channels?.discord?.dm?.groupEnabled).toBe(true);
      expect(cfg.channels?.discord?.dm?.groupChannels).toEqual(["openclaw-dm"]);
      expect(cfg.channels?.discord?.actions?.emojiUploads).toBe(true);
      expect(cfg.channels?.discord?.actions?.stickerUploads).toBe(false);
      expect(cfg.channels?.discord?.actions?.channels).toBe(true);
      expect(cfg.channels?.discord?.guilds?.["123"]?.slug).toBe("friends-of-openclaw");
      expect(cfg.channels?.discord?.guilds?.["123"]?.channels?.general?.allow).toBe(true);
    });
  });
});

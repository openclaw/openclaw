import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

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
                  general: { enabled: true, autoThread: true },
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
        expect(cfg.channels?.discord?.guilds?.["123"]?.channels?.general?.enabled).toBe(true);
        expect(cfg.channels?.discord?.guilds?.["123"]?.channels?.general?.autoThread).toBe(true);
      },
    );
  });

  it("coerces safe-integer numeric discord allowlist entries to strings", () => {
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

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.discord?.allowFrom).toEqual(["123"]);
      expect(res.config.channels?.discord?.dm?.allowFrom).toEqual(["456"]);
      expect(res.config.channels?.discord?.dm?.groupChannels).toEqual(["789"]);
      expect(res.config.channels?.discord?.guilds?.["123"]?.users).toEqual(["111"]);
      expect(res.config.channels?.discord?.guilds?.["123"]?.roles).toEqual(["222"]);
      expect(res.config.channels?.discord?.guilds?.["123"]?.channels?.general?.users).toEqual([
        "333",
      ]);
      expect(res.config.channels?.discord?.guilds?.["123"]?.channels?.general?.roles).toEqual([
        "444",
      ]);
      expect(res.config.channels?.discord?.execApprovals?.approvers).toEqual(["555"]);
    }
  });

  it("rejects numeric discord IDs that are not valid non-negative safe integers", () => {
    const cases = [106232522769186816, -1, 123.45];
    for (const id of cases) {
      const res = validateConfigObject({
        channels: {
          discord: {
            allowFrom: [id],
          },
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(
          res.issues.some((issue) =>
            issue.message.includes("not a valid non-negative safe integer"),
          ),
        ).toBe(true);
      }
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import { isChannelConfigured } from "./channel-configured.js";

describe("isChannelConfigured", () => {
  it("detects Telegram env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Discord env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Slack env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(true);
  });

  it("requires both IRC host and nick env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "irc", { IRC_HOST: "irc.example.com" })).toBe(false);
    expect(
      isChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
  });

  it("still falls back to generic config presence for channels without a custom hook", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            signal: {
              httpPort: 8080,
            },
          },
        },
        "signal",
        {},
      ),
    ).toBe(true);
  });

  it("detects persisted Matrix credentials through package metadata", () => {
    withTempDirSync({ prefix: "openclaw-channel-configured-" }, (stateDir) => {
      fs.mkdirSync(path.join(stateDir, "credentials", "matrix"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
        JSON.stringify({
          homeserver: "https://matrix.example.org",
          userId: "@ops:example.org",
          accessToken: "token",
        }),
        "utf8",
      );

      expect(isChannelConfigured({}, "matrix", { OPENCLAW_STATE_DIR: stateDir })).toBe(true);
    });
  });
});

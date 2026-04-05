import { describe, expect, it } from "vitest";
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
});

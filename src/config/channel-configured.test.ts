import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isChannelConfigured } from "./channel-configured.js";

const tempDirs: string[] = [];

function makeTempStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-configured-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

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
    const stateDir = makeTempStateDir();
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

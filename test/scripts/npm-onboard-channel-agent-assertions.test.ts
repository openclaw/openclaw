import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const assertionsPath = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs");

function writeConfig(home: string, channels: Record<string, unknown>): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "openclaw.json"), JSON.stringify({ channels }));
}

function runAssert(home: string, channel: string, ...tokens: string[]) {
  return spawnSync(
    process.execPath,
    [assertionsPath, "assert-channel-config", channel, ...tokens],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
      },
    },
  );
}

describe("npm onboard channel agent assertions", () => {
  it("validates channel tokens in their canonical config fields", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        discord: { enabled: true, token: "discord-token" },
        slack: { enabled: true, appToken: "xapp-token", botToken: "xoxb-token" },
        telegram: { enabled: true, botToken: "telegram-token" },
      });

      expect(runAssert(tempDir, "telegram", "telegram-token").status).toBe(0);
      expect(runAssert(tempDir, "discord", "discord-token").status).toBe(0);
      expect(runAssert(tempDir, "slack", "xoxb-token", "xapp-token").status).toBe(0);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects tokens persisted on the wrong channel config field", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        telegram: { enabled: true, token: "telegram-token" },
      });

      const result = runAssert(tempDir, "telegram", "telegram-token");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("telegram config did not persist botToken");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

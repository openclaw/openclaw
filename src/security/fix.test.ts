import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixSecurityFootguns } from "./fix.js";

describe("security fix", () => {
  it("tightens groupPolicy + filesystem perms", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-fix-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          channels: {
            telegram: { groupPolicy: "open" },
            whatsapp: { groupPolicy: "open" },
            discord: { groupPolicy: "open" },
            signal: { groupPolicy: "open" },
            imessage: { groupPolicy: "open" },
          },
          logging: { redactSensitive: "off" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.chmod(configPath, 0o644);

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      path.join(credsDir, "whatsapp-allowFrom.json"),
      `${JSON.stringify({ version: 1, allowFrom: [" +15551234567 "] }, null, 2)}\n`,
      "utf-8",
    );

    const env = {
      ...process.env,
      CLAWDBOT_STATE_DIR: stateDir,
      CLAWDBOT_CONFIG_PATH: "",
    };

    const res = await fixSecurityFootguns({ env });
    expect(res.ok).toBe(true);
    expect(res.configWritten).toBe(true);
    expect(res.changes).toEqual(
      expect.arrayContaining([
        "channels.telegram.groupPolicy=open -> allowlist",
        "channels.whatsapp.groupPolicy=open -> allowlist",
        "channels.discord.groupPolicy=open -> allowlist",
        "channels.signal.groupPolicy=open -> allowlist",
        "channels.imessage.groupPolicy=open -> allowlist",
        'logging.redactSensitive=off -> "tools"',
      ]),
    );

    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expect(stateMode).toBe(0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expect(configMode).toBe(0o600);

    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = parsed.channels as Record<string, Record<string, unknown>>;
    expect(channels.telegram.groupPolicy).toBe("allowlist");
    expect(channels.whatsapp.groupPolicy).toBe("allowlist");
    expect(channels.discord.groupPolicy).toBe("allowlist");
    expect(channels.signal.groupPolicy).toBe("allowlist");
    expect(channels.imessage.groupPolicy).toBe("allowlist");

    expect(channels.whatsapp.groupAllowFrom).toEqual(["+15551234567"]);
  });

  it("applies allowlist per-account and seeds WhatsApp groupAllowFrom from store", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-fix-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });

    const configPath = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          channels: {
            whatsapp: {
              accounts: {
                a1: { groupPolicy: "open" },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      path.join(credsDir, "whatsapp-allowFrom.json"),
      `${JSON.stringify({ version: 1, allowFrom: ["+15550001111"] }, null, 2)}\n`,
      "utf-8",
    );

    const env = {
      ...process.env,
      CLAWDBOT_STATE_DIR: stateDir,
      CLAWDBOT_CONFIG_PATH: "",
    };

    const res = await fixSecurityFootguns({ env });
    expect(res.ok).toBe(true);

    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = parsed.channels as Record<string, Record<string, unknown>>;
    const whatsapp = channels.whatsapp as Record<string, unknown>;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;

    expect(accounts.a1.groupPolicy).toBe("allowlist");
    expect(accounts.a1.groupAllowFrom).toEqual(["+15550001111"]);
  });

  it("does not seed WhatsApp groupAllowFrom if allowFrom is set", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-fix-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });

    const configPath = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          channels: {
            whatsapp: { groupPolicy: "open", allowFrom: ["+15552223333"] },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    await fs.writeFile(
      path.join(credsDir, "whatsapp-allowFrom.json"),
      `${JSON.stringify({ version: 1, allowFrom: ["+15550001111"] }, null, 2)}\n`,
      "utf-8",
    );

    const env = {
      ...process.env,
      CLAWDBOT_STATE_DIR: stateDir,
      CLAWDBOT_CONFIG_PATH: "",
    };

    const res = await fixSecurityFootguns({ env });
    expect(res.ok).toBe(true);

    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const channels = parsed.channels as Record<string, Record<string, unknown>>;
    expect(channels.whatsapp.groupPolicy).toBe("allowlist");
    expect(channels.whatsapp.groupAllowFrom).toBeUndefined();
  });

  it("returns ok=false for invalid config but still tightens perms", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-security-fix-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(configPath, "{ this is not json }\n", "utf-8");
    await fs.chmod(configPath, 0o644);

    const env = {
      ...process.env,
      CLAWDBOT_STATE_DIR: stateDir,
      CLAWDBOT_CONFIG_PATH: "",
    };

    const res = await fixSecurityFootguns({ env });
    expect(res.ok).toBe(false);

    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expect(stateMode).toBe(0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expect(configMode).toBe(0o600);
  });
});

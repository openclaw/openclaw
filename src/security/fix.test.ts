import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { fixSecurityFootguns } from "./fix.js";

const isWindows = process.platform === "win32";

const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("security fix", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createStateDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createFixEnv = (stateDir: string, configPath: string): NodeJS.ProcessEnv => ({
    // Keep this test environment hermetic; unrelated suites can mutate process.env.
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
  });

  const writeJsonConfig = async (configPath: string, config: Record<string, unknown>) => {
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  };

  const writeWhatsAppConfig = async (configPath: string, whatsapp: Record<string, unknown>) => {
    await writeJsonConfig(configPath, {
      channels: {
        whatsapp,
      },
    });
  };

  const readParsedConfig = async (configPath: string) =>
    JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;

  const runFixAndReadChannels = async (stateDir: string, configPath: string) => {
    const env = createFixEnv(stateDir, configPath);
    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    const parsed = await readParsedConfig(configPath);
    return {
      res,
      channels: parsed.channels as Record<string, Record<string, unknown>>,
    };
  };

  const expectTightenedStateAndConfigPerms = async (stateDir: string, configPath: string) => {
    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expectPerms(stateMode, 0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expectPerms(configMode, 0o600);
  };

  const runWhatsAppFixScenario = async (params: {
    stateDir: string;
    configPath: string;
    whatsapp: Record<string, unknown>;
    allowFromStore: string[];
  }) => {
    await writeWhatsAppConfig(params.configPath, params.whatsapp);
    await writeWhatsAppAllowFromStore(params.stateDir, params.allowFromStore);
    return runFixAndReadChannels(params.stateDir, params.configPath);
  };

  const writeWhatsAppAllowFromStore = async (stateDir: string, allowFrom: string[]) => {
    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    const payload = `${JSON.stringify({ version: 1, allowFrom }, null, 2)}\n`;
    const env = createFixEnv(stateDir, path.join(stateDir, "openclaw.json"));
    const targetPaths = new Set<string>([
      resolveChannelAllowFromPath("whatsapp", env),
      resolveChannelAllowFromPath("whatsapp", env, DEFAULT_ACCOUNT_ID),
    ]);
    await Promise.all(
      [...targetPaths].map(async (targetPath) => {
        await fs.writeFile(targetPath, payload, "utf-8");
      }),
    );
  };

  const expectWhatsAppGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    expectedPolicy = "allowlist",
  ) => {
    expect(channels.whatsapp.groupPolicy).toBe(expectedPolicy);
  };

  const expectWhatsAppAccountGroupPolicy = (
    channels: Record<string, Record<string, unknown>>,
    accountId: string,
    expectedPolicy = "allowlist",
  ) => {
    const whatsapp = channels.whatsapp;
    const accounts = whatsapp.accounts as Record<string, Record<string, unknown>>;
    expect(accounts[accountId]?.groupPolicy).toBe(expectedPolicy);
    return accounts;
  };

  const fixWhatsAppScenario = async (params: {
    prefix: string;
    whatsapp: Record<string, unknown>;
    allowFromStore: string[];
  }) => {
    const stateDir = await createStateDir(params.prefix);
    const configPath = path.join(stateDir, "openclaw.json");
    const result = await runWhatsAppFixScenario({
      stateDir,
      configPath,
      whatsapp: params.whatsapp,
      allowFromStore: params.allowFromStore,
    });
    return { stateDir, configPath, ...result };
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-fix-suite-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("tightens groupPolicy + filesystem perms", async () => {
    const stateDir = await createStateDir("tightens");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await writeJsonConfig(configPath, {
      channels: {
        telegram: { groupPolicy: "open" },
        whatsapp: { groupPolicy: "open" },
        discord: { groupPolicy: "open" },
        signal: { groupPolicy: "open" },
        imessage: { groupPolicy: "open" },
      },
      logging: { redactSensitive: "off" },
    });
    await fs.chmod(configPath, 0o644);

    await writeWhatsAppAllowFromStore(stateDir, [" +15551234567 "]);
    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
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

    await expectTightenedStateAndConfigPerms(stateDir, configPath);

    const parsed = await readParsedConfig(configPath);
    const channels = parsed.channels as Record<string, Record<string, unknown>>;
    expect(channels.telegram.groupPolicy).toBe("allowlist");
    expect(channels.whatsapp.groupPolicy).toBe("allowlist");
    expect(channels.discord.groupPolicy).toBe("allowlist");
    expect(channels.signal.groupPolicy).toBe("allowlist");
    expect(channels.imessage.groupPolicy).toBe("allowlist");

    expect(channels.whatsapp.groupAllowFrom).toEqual(["+15551234567"]);
  });

  it("applies allowlist per-account and seeds WhatsApp groupAllowFrom from store", async () => {
    const { res, channels } = await fixWhatsAppScenario({
      prefix: "per-account",
      whatsapp: {
        accounts: {
          a1: { groupPolicy: "open" },
        },
      },
      allowFromStore: ["+15550001111"],
    });
    expect(res.ok).toBe(true);
    const accounts = expectWhatsAppAccountGroupPolicy(channels, "a1");
    expect(accounts.a1.groupAllowFrom).toEqual(["+15550001111"]);
  });

  it("does not seed WhatsApp groupAllowFrom if allowFrom is set", async () => {
    const { res, channels } = await fixWhatsAppScenario({
      prefix: "no-seed",
      whatsapp: {
        groupPolicy: "open",
        allowFrom: ["+15552223333"],
      },
      allowFromStore: ["+15550001111"],
    });
    expect(res.ok).toBe(true);
    expectWhatsAppGroupPolicy(channels);
    expect(channels.whatsapp.groupAllowFrom).toBeUndefined();
  });

  it("returns ok=false for invalid config but still tightens perms", async () => {
    const stateDir = await createStateDir("invalid-config");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{ this is not json }\n", "utf-8");
    await fs.chmod(configPath, 0o644);

    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    expect(res.ok).toBe(false);

    await expectTightenedStateAndConfigPerms(stateDir, configPath);
  });

  it("tightens perms for credentials + agent auth/sessions + include files", async () => {
    const stateDir = await createStateDir("includes");

    const includesDir = path.join(stateDir, "includes");
    await fs.mkdir(includesDir, { recursive: true });
    const includePath = path.join(includesDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    await fs.chmod(includePath, 0o644);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{ "$include": "./includes/extra.json5", channels: { whatsapp: { groupPolicy: "open" } } }\n`,
      "utf-8",
    );
    await fs.chmod(configPath, 0o644);

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    const allowFromPath = path.join(credsDir, "whatsapp-allowFrom.json");
    await fs.writeFile(
      allowFromPath,
      `${JSON.stringify({ version: 1, allowFrom: ["+15550002222"] }, null, 2)}\n`,
      "utf-8",
    );
    await fs.chmod(allowFromPath, 0o644);

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authProfilesPath, "{}\n", "utf-8");
    await fs.chmod(authProfilesPath, 0o644);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionsStorePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(sessionsStorePath, "{}\n", "utf-8");
    await fs.chmod(sessionsStorePath, 0o644);
    const transcriptPath = path.join(sessionsDir, "sess-main.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session"}\n', "utf-8");
    await fs.chmod(transcriptPath, 0o644);

    const res = await fixSecurityFootguns({
      env: createFixEnv(stateDir, configPath),
      stateDir,
      configPath,
    });
    expect(res.ok).toBe(true);

    const permissionChecks: Array<readonly [string, number]> = [
      [credsDir, 0o700],
      [allowFromPath, 0o600],
      [authProfilesPath, 0o600],
      [sessionsStorePath, 0o600],
      [transcriptPath, 0o600],
      [includePath, 0o600],
    ];
    await Promise.all(
      permissionChecks.map(async ([targetPath, expectedMode]) =>
        expectPerms((await fs.stat(targetPath)).mode & 0o777, expectedMode),
      ),
    );
  });
});

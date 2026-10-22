import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
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

  const runFix = (
    stateDir: string,
    configPath: string,
    channelPlugins?: ChannelPlugin[],
    env: NodeJS.ProcessEnv = {},
  ) =>
    fixSecurityFootguns({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        ...env,
      },
      stateDir,
      configPath,
      channelPlugins,
    });

  const writePublicFile = async (filePath: string, content = "{}\n") => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    await fs.chmod(filePath, 0o644);
  };

  const createWhatsAppConfigFixTestPlugin = (storeAllowFrom: string[]): ChannelPlugin => ({
    ...createChannelTestPluginBase({
      id: "whatsapp",
      label: "WhatsApp",
      docsPath: "/docs/testing",
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        inspectAccount: () => ({
          accountId: "default",
          enabled: true,
          configured: true,
          config: {},
        }),
        resolveAccount: () => ({ accountId: "default", enabled: true, config: {} }),
        isEnabled: () => true,
        isConfigured: () => true,
      },
    }),
    security: {
      applyConfigFixes: async ({ cfg }) => {
        if (storeAllowFrom.length === 0) {
          return { config: cfg, changes: [] };
        }
        const next = structuredClone(cfg ?? {});
        const whatsapp = next.channels?.whatsapp as Record<string, unknown> | undefined;
        if (!whatsapp || typeof whatsapp !== "object") {
          return { config: cfg, changes: [] };
        }
        const changes: string[] = [];
        const maybeApply = (prefix: string, holder: Record<string, unknown>) => {
          if (holder.groupPolicy !== "open") {
            return;
          }
          const allowFrom = Array.isArray(holder.allowFrom) ? holder.allowFrom : [];
          const groupAllowFrom = Array.isArray(holder.groupAllowFrom) ? holder.groupAllowFrom : [];
          if (allowFrom.length > 0 || groupAllowFrom.length > 0) {
            return;
          }
          holder.groupAllowFrom = [...storeAllowFrom];
          changes.push(`${prefix}groupAllowFrom=pairing-store`);
        };

        maybeApply("channels.whatsapp.", whatsapp);
        const accounts = whatsapp.accounts;
        if (accounts && typeof accounts === "object") {
          for (const [accountId, value] of Object.entries(accounts)) {
            if (!value || typeof value !== "object") {
              continue;
            }
            maybeApply(
              `channels.whatsapp.accounts.${accountId}.`,
              value as Record<string, unknown>,
            );
          }
        }

        return { config: changes.length ? next : cfg, changes };
      },
    },
  });

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-fix-suite-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  const channelIds = ["telegram", "whatsapp", "discord", "signal", "imessage"] as const;
  const groupPolicies = (groupPolicy: "open" | "allowlist") =>
    Object.fromEntries(channelIds.map((id) => [id, { groupPolicy }]));
  const allowlisted = {
    groupPolicy: "allowlist",
    accounts: { default: { groupPolicy: "allowlist" }, work: { groupPolicy: "allowlist" } },
  } as const;
  it.each([
    {
      name: "tightens group policies after plugin fixes",
      cfg: { channels: groupPolicies("open") },
      store: ["+15551234567"],
      result: {
        changes: [
          ...channelIds.map((id) => `channels.${id}.groupPolicy=open -> allowlist`),
          "channels.whatsapp.groupAllowFrom=pairing-store",
        ],
      },
      channels: {
        ...groupPolicies("allowlist"),
        whatsapp: { groupPolicy: "allowlist", groupAllowFrom: ["+15551234567"] },
      },
    },
    {
      name: "converts and seeds per-account policies",
      cfg: { channels: { whatsapp: { accounts: { a1: { groupPolicy: "open" } } } } },
      store: ["+15550001111"],
      result: { ok: true },
      channels: {
        whatsapp: {
          accounts: { a1: { groupPolicy: "allowlist", groupAllowFrom: ["+15550001111"] } },
        },
      },
    },
    {
      name: "leaves already allowlisted accounts unseeded",
      cfg: { channels: { whatsapp: allowlisted } },
      store: ["+15550001111"],
      result: { configWritten: false, changes: [] },
      channels: { whatsapp: allowlisted },
      unseeded: true,
    },
  ] satisfies Array<{
    name: string;
    cfg: OpenClawConfig;
    store: string[];
    result: Partial<Awaited<ReturnType<typeof fixSecurityFootguns>>>;
    channels: OpenClawConfig["channels"];
    unseeded?: boolean;
  }>)("$name", async (scenario) => {
    const stateDir = await createStateDir("group-policy");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(scenario.cfg), "utf-8");
    const res = await runFix(stateDir, configPath, [
      createWhatsAppConfigFixTestPlugin(scenario.store),
    ]);
    const cfg = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
    expect(res).toMatchObject(scenario.result);
    expect(cfg.channels).toMatchObject(scenario.channels);
    if ("unseeded" in scenario) {
      const whatsapp = expectDefined(cfg.channels?.whatsapp, "whatsapp");
      expect(whatsapp.groupAllowFrom).toBeUndefined();
      for (const id of ["default", "work"]) {
        expect(whatsapp.accounts?.[id]?.groupAllowFrom).toBeUndefined();
      }
    }
  });

  it("collects permission targets for credentials + agent auth/sessions + include files", async () => {
    const stateDir = await createStateDir("includes");

    const includePath = path.join(stateDir, "includes", "extra.json5");
    await writePublicFile(includePath);

    const configPath = path.join(stateDir, "openclaw.json");
    await writePublicFile(configPath, `{ "$include": "./includes/extra.json5" }\n`);

    const credsDir = path.join(stateDir, "credentials");
    const credentialPath = path.join(credsDir, "oauth.json");
    await writePublicFile(credentialPath);

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authDatabasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionsStorePath = path.join(sessionsDir, "sessions.json");
    const transcriptPath = path.join(sessionsDir, "sess-main.jsonl");
    await writePublicFile(transcriptPath, '{"type":"session"}\n');

    const result = await runFix(stateDir, configPath, []);
    const canonicalIncludePath = await fs.realpath(includePath);

    expect(result.actions.map((action) => action.path)).toEqual([
      stateDir,
      configPath,
      canonicalIncludePath,
      credsDir,
      credentialPath,
      path.join(stateDir, "agents", "main"),
      agentDir,
      authDatabasePath,
      `${authDatabasePath}-wal`,
      `${authDatabasePath}-shm`,
      `${authDatabasePath}-journal`,
      authProfilesPath,
      sessionsDir,
      sessionsStorePath,
      transcriptPath,
    ]);
  });

  it("tightens the live legacy main auth store for a named default roster", async () => {
    const stateDir = await createStateDir("named-default-legacy-auth");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { ops: {} } } }), "utf-8");
    const legacyAuthPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await writePublicFile(legacyAuthPath);

    const result = await runFix(stateDir, configPath, []);

    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "chmod", ok: true, path: legacyAuthPath, mode: 0o600 }),
    );
    expectPerms((await fs.stat(legacyAuthPath)).mode & 0o777, 0o600);
  });

  it.runIf(process.platform !== "win32").each([
    { name: "rejects escaped includes", allowed: false },
    { name: "keeps explicitly allowed include roots", allowed: true },
  ])("$name", async ({ allowed }) => {
    const stateDir = await createStateDir("include-boundary");
    const configPath = path.join(stateDir, "openclaw.json");
    const safePath = path.join(stateDir, "safe.json5");
    const externalPath = path.join(
      fixtureRoot,
      allowed ? "shared-includes/shared.json5" : "escaped.json5",
    );
    await writePublicFile(externalPath);
    if (!allowed) {
      await writePublicFile(safePath);
    }
    await fs.writeFile(
      configPath,
      JSON.stringify({
        $include: allowed ? externalPath : ["./safe.json5", "../escaped.json5"],
      }),
      "utf-8",
    );
    const result = await runFix(
      stateDir,
      configPath,
      undefined,
      allowed ? { OPENCLAW_INCLUDE_ROOTS: path.dirname(externalPath) } : {},
    );
    if (allowed) {
      expect(result.actions).toContainEqual(
        expect.objectContaining({
          kind: "chmod",
          ok: true,
          path: await fs.realpath(externalPath),
          mode: 0o600,
        }),
      );
    } else {
      expect(result.actions.some((action) => action.path === externalPath)).toBe(false);
      expectPerms((await fs.stat(safePath)).mode & 0o777, 0o600);
    }
    expectPerms((await fs.stat(externalPath)).mode & 0o777, allowed ? 0o600 : 0o644);
  });
});

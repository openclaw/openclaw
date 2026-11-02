import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

function withMigrationHome(run: (home: string) => Promise<void>, env: NodeJS.ProcessEnv = {}) {
  return withDoctorConfigPreflightHome((home) =>
    withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        ...env,
      },
      () => run(home),
    ),
  );
}

async function runDoctor(configPath: string, repair?: boolean) {
  const ctx = await prepareDoctorContext(configPath, { options: { nonInteractive: true, repair } });
  await ctx[Symbol.asyncDispose]();
}

async function writeFixture(home: string, config: unknown) {
  const configPath = await writeOpenClawConfig(home, config);
  return { configPath, original: await fs.readFile(configPath, "utf8") };
}

it("backs up and persists inherited Talk SecretRefs for an unmarked published updater", () =>
  withMigrationHome(async (home) => {
    const apiKey = { source: "env", provider: "default", id: "TALK_MIGRATION_TEST_KEY" } as const;
    const voiceConfig = {
      realtime: { provider: "openai", providers: { openai: { apiKey } } },
      streaming: { provider: "openai-realtime" },
    };
    const raw = {
      gateway: { mode: "local" as const },
      talk: { realtime: { speakerVoice: "marin" } },
      plugins: {
        enabled: false,
        entries: { "voice-call": { config: voiceConfig } },
      },
    };
    const { configPath, original } = await writeFixture(home, raw);
    const before = await readConfigFileSnapshot();
    expect(before).toMatchObject({ valid: true, raw: original });
    expect(before.sourceConfig.talk).toEqual(raw.talk);
    expect(findLegacyConfigIssues(before.sourceConfig, before.parsed)).toContainEqual({
      path: "plugins.entries.voice-call.config.realtime",
      message: expect.stringContaining("talk.realtime"),
    });

    await runDoctor(configPath);
    const saved = await readConfigFileSnapshot();
    expect(saved.valid).toBe(true);
    expect(saved.sourceConfig.talk?.realtime).toEqual({
      provider: "openai",
      providers: { openai: { apiKey } },
      speakerVoice: "marin",
    });
    expect(saved.sourceConfig.plugins?.entries?.["voice-call"]?.config).toEqual(voiceConfig);
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
    await runDoctor(configPath);
    expect((await readConfigFileSnapshot()).raw).toBe(saved.raw);
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
  }));

it.each([
  { extra: "session_status", repaired: true, sandbox: false },
  { extra: "exec", repaired: false, sandbox: false },
  { extra: "message", repaired: false, sandbox: true },
])(
  "preserves permissions during repair ($extra, sandbox=$sandbox)",
  ({ extra, repaired, sandbox }) =>
    withMigrationHome(async (home) => {
      const tools = sandbox
        ? { sandbox: { tools: { allow: ["read", "message"], alsoAllow: [extra] } } }
        : { profile: "minimal" as const, allow: ["session_status", "exec"], alsoAllow: [extra] };
      const raw: OpenClawConfig = {
        gateway: { mode: "local", port: await getFreePort() },
        plugins: { enabled: false },
        tools: sandbox ? { sandbox: { tools: { alsoAllow: ["exec"] } } } : { alsoAllow: ["exec"] },
        agents: { ownership: "explicit", entries: { restricted: { tools } } },
      };
      const { configPath, original } = await writeFixture(home, raw);
      const before = resolveSandboxToolPolicyForAgent(raw, "restricted");
      if (sandbox) {
        expect(isToolAllowed(before, "exec")).toBe(false);
      }
      await runDoctor(configPath, true);
      const saved = await readConfigFileSnapshot();
      expect(saved.valid).toBe(repaired);
      if (sandbox) {
        const after = resolveSandboxToolPolicyForAgent(saved.sourceConfig, "restricted");
        expect(isToolAllowed(after, "exec")).toBe(false);
        expect(after).toStrictEqual(before);
      } else {
        expect(saved.sourceConfig.agents?.entries?.restricted?.tools?.alsoAllow).toEqual(
          repaired ? [] : [extra],
        );
      }
      if (repaired) {
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
      } else {
        expect(saved.raw).toBe(original);
      }
    }),
);

it("normalizes retired metadata and Code Mode config for an unmarked npm updater without repair flags", () =>
  withMigrationHome(async (home) => {
    const { configPath, original } = await writeFixture(home, {
      meta: { lastTouchedVersion: "2026.3.31", lastTouchedAt: "2026-03-31T00:00:00.000Z" },
      gateway: { mode: "local", port: 19092 },
      tools: {
        codeMode: {
          enabled: true,
          runtime: "quickjs-wasi",
          languages: ["typescript"],
          timeoutMs: 2500,
        },
      },
      plugins: { enabled: false },
    });
    expect((await readConfigFileSnapshot()).valid).toBe(false);
    await using ctx = await prepareDoctorContext(configPath, { options: { nonInteractive: true } });
    expect(ctx.prompter.shouldRepair).toBe(false);
    const saved = await readConfigFileSnapshot();
    expect(saved.valid).toBe(true);
    expect(saved.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
    expect(saved.sourceConfig.gateway).toEqual({ mode: "local", port: 19092 });
    expect(saved.sourceConfig.tools?.codeMode).toEqual({
      enabled: true,
      executor: "quickjs",
      timeoutMs: 2500,
    });
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
  }));

it.each<[string, NodeJS.ProcessEnv?]>([
  ["legacy", { OPENCLAW_UPDATE_IN_PROGRESS: "legacy" }],
  ["include"],
  ["invalid"],
  ["future"],
  ["readonly", { OPENCLAW_CONFIG_READONLY: "1" }],
  ["nix", { OPENCLAW_NIX_MODE: "1" }],
  [
    "handoff",
    { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" },
  ],
  ["missing-plugin", { OPENCLAW_UPDATE_IN_PROGRESS: "1" }],
])("preserves %s config bytes during ordinary Doctor", (kind, env) =>
  withMigrationHome(
    async (home) => {
      const legacy = kind === "legacy";
      const include = kind === "include";
      const canonical = { source: "path" as const, installPath: path.join(home, "canonical") };
      if (legacy) {
        await seedInstalledPluginIndex(
          { existing: canonical },
          { config: { plugins: { enabled: false } } },
        );
      }
      const configPath = await writeOpenClawConfig(home, {
        ...(legacy
          ? { agents: { list: [{ id: "main", name: "Operator" }, { id: "helper" }] } }
          : {}),
        meta: {
          lastTouchedAt: legacy ? "2026-02-15T00:00:00.000Z" : "2026-03-31T00:00:00.000Z",
          lastTouchedVersion: legacy ? "2026.2.15" : kind === "future" ? "9999.1.1" : "2026.3.31",
          ...(kind === "invalid" ? { unknownSetting: true } : {}),
        },
        gateway: include ? { $include: "gateway.json" } : { mode: "local" },
        plugins:
          kind === "missing-plugin"
            ? { load: { paths: [path.join(home, "missing-plugin")] } }
            : { enabled: false },
      });
      if (include) {
        await fs.writeFile(path.join(path.dirname(configPath), "gateway.json"), '{"mode":"local"}');
      }
      const original = await fs.readFile(configPath, "utf8");

      await runDoctor(configPath, legacy || undefined);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      if (legacy) {
        expect(await readPersistedInstalledPluginIndexInstallRecordsAsync()).toEqual({
          existing: canonical,
        });
      }
    },
    {
      OPENCLAW_CONFIG_READONLY: undefined,
      OPENCLAW_NIX_MODE: undefined,
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
      ...env,
    },
  ),
);

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordUnwrittenWebhookCompletion } from "../commands/doctor/shared/legacy-webhook-pins.js";
import { createConfigIO } from "../config/io.factory.js";
import { replaceConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordGatewayBootStart } from "../infra/gateway-boot-lifecycle.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyResolvedPluginDoctorCompatibilityMigrations } from "./doctor-compatibility-migration.js";
import { applyPluginDoctorCompatibilityMigrations } from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    clearPluginDoctorContractRegistryCache();
    await closeStateDatabaseForTest();
    cleanup();
  });
});
const endpoint = { port: 8788, host: "0.0.0.0" };

async function fixture(
  accountIds: Array<string | undefined> = ["work"],
  options: {
    channelId?: "nextcloud-talk" | "msteams";
    preserveAuthoredActivation?: true;
    unreportedEdit?: true;
  } = {},
) {
  const channelId = options.channelId ?? "nextcloud-talk";
  const root = tempDirs.make("openclaw-doctor-webhook-pins-");
  const configPath = path.join(root, "openclaw.json");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  await fs.writeFile(
    path.join(root, "doctor-contract-api.cjs"),
    `module.exports = {
      historicalWebhookListener: ${JSON.stringify({
        channelId,
        ...(channelId === "msteams" ? { port: 3978 } : endpoint),
        ...(options.preserveAuthoredActivation ? { preserveAuthoredActivation: true } : {}),
      })},
      normalizeCompatibilityConfig: ({ cfg }) => {
        ${options.unreportedEdit ? "cfg.gateway = { port: 10000 };" : ""}
        return { config: cfg, changes: [], historicalWebhookAccountIds: [${accountIds.map((id) => (id === undefined ? "undefined" : JSON.stringify(id))).join(", ")}] };
      }
    };\n`,
  );
  const owner = createPluginManifestRecordFixture({
    id: channelId,
    rootDir: root,
    channels: [channelId],
    doctorContract: { configRepair: true },
  });
  const manifestRegistry = { plugins: [owner], diagnostics: [] };
  const migrate = (config: OpenClawConfig, migrationEnv: NodeJS.ProcessEnv = env) =>
    applyPluginDoctorCompatibilityMigrations(config, {
      env: migrationEnv,
      pluginIds: [channelId],
      manifestRegistry,
      historicalWebhookListeners: true,
    });
  return {
    configPath,
    env,
    migrate,
    owner,
    update: (config: OpenClawConfig) =>
      migrate(config, { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" }),
  };
}

function channelConfig(
  accounts: Record<string, Record<string, unknown>> = { work: { enabled: true } },
): OpenClawConfig {
  return { channels: { "nextcloud-talk": { accounts } } };
}

function rehearsalEnv(env: NodeJS.ProcessEnv, configPath: string) {
  return {
    ...env,
    ...buildUpdateRehearsalPathEnv(path.dirname(configPath)),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  };
}

const workChannel = (legacyWebhook?: typeof endpoint) => ({
  accounts: { work: { enabled: true, ...(legacyWebhook ? { legacyWebhook } : {}) } },
});

function expectUnchanged(
  result: ReturnType<typeof applyPluginDoctorCompatibilityMigrations>,
  config: OpenClawConfig,
) {
  expect(result).toEqual({ config, changes: [] });
}

function expectReads<T>(table: string, count: number, run: () => T): T {
  const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    const result = run();
    expect(
      sql.queries.filter((query) => query.toLowerCase().includes(`from "${table}"`)),
    ).toHaveLength(count);
    return result;
  } finally {
    sql.restore();
  }
}

it("shares one completion read and preserves each rehearsal write across plugins", async () => {
  const { configPath, env } = await fixture([]);
  const migrationEnv = rehearsalEnv(env, configPath);
  let accountIds: string[] = [];
  const entries = ["nextcloud-talk", "msteams"].map((pluginId) => ({
    pluginId,
    rules: [],
    providerRenames: [],
    historicalWebhookListener: { channelId: pluginId, ...endpoint },
    normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
      config: cfg,
      changes: [],
      historicalWebhookAccountIds: accountIds,
    }),
  }));
  const migrate = (config: OpenClawConfig) =>
    applyResolvedPluginDoctorCompatibilityMigrations(config, entries, {
      env: migrationEnv,
      historicalWebhookListeners: true,
      isDeferred: () => false,
    });
  openOpenClawStateDatabase({ env: migrationEnv });
  expectUnchanged(
    expectReads("config_machine_state", 1, () => migrate({})),
    {},
  );
  expect(readConfigMachineState(`webhookListeners:${configPath}`, { env: migrationEnv })).toEqual({
    "nextcloud-talk": [],
    msteams: [],
  });
  const config: OpenClawConfig = {
    channels: { "nextcloud-talk": { accounts: { work: {} } }, msteams: {} },
  };
  accountIds = ["work"];
  expectUnchanged(migrate(config), config);
});

it.each([{ accountIds: [] }, { accountIds: ["work"] }])(
  "keeps real rehearsal webhook pins and records no-op completion in state: $accountIds",
  async ({ accountIds }) => {
    const { configPath, env, migrate } = await fixture(accountIds);
    const migrationEnv = rehearsalEnv(env, configPath);
    const config = channelConfig();
    const result = migrate(config, migrationEnv);
    if (accountIds.length === 0) {
      expectUnchanged(result, config);
      expectUnchanged(migrate(config, migrationEnv), config);
    } else {
      expect(result.config.channels?.["nextcloud-talk"]).toEqual(workChannel(endpoint));
      expect(result.config.meta?.migrations?.webhookListeners).toEqual({
        "nextcloud-talk": [["channels", "nextcloud-talk", "accounts", "work", "legacyWebhook"]],
      });
    }
  },
);

it.each([
  { name: "reported installed repair", pin: true },
  { name: "unreported installed edit", reported: false },
  { name: "untrusted owner", trusted: false },
  { name: "disabled plugins", plugins: { enabled: false } },
  { name: "restrictive allowlist", plugins: { allow: ["different-plugin"] } },
  { name: "denied owner", plugins: { deny: ["nextcloud-talk"] } },
])(
  "supplements historical facts without replacing $name",
  async ({ reported = true, trusted = true, plugins = {}, pin = false }) => {
    const { configPath, env, migrate, owner: installed } = await fixture();
    installed.origin = "global";
    installed.trustedOfficialInstall = trusted;
    const root = path.dirname(configPath);
    await fs.writeFile(
      path.join(root, "doctor-contract-api.cjs"),
      `module.exports = {
        normalizeCompatibilityConfig: ({ cfg }) => {
          cfg.gateway = { port: 17777 };
          return { config: cfg, changes: ${JSON.stringify(reported ? ["installed repair"] : [])} };
        }
      };\n`,
    );
    const bundledRoot = path.join(root, "bundled");
    const pluginRoot = path.join(bundledRoot, "nextcloud-talk");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
    await fs.writeFile(
      path.join(pluginRoot, "config-doctor-api.js"),
      `module.exports = {
        historicalWebhookListener: ${JSON.stringify({ channelId: "nextcloud-talk", ...endpoint })},
        normalizeCompatibilityConfig: ({ cfg }) => {
          const eligible = cfg.gateway?.port === 17777;
          cfg.gateway = { port: 19999 };
          return { config: cfg, changes: ["host repair"], historicalWebhookAccountIds: eligible ? ["work"] : [] };
        }
      };\n`,
    );
    const config: OpenClawConfig = {
      gateway: { port: 16666 },
      channels: { "nextcloud-talk": { enabled: true, ...workChannel() } },
      plugins,
    };
    const result = migrate(config, {
      ...env,
      VITEST: "true",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    });
    expect(result.warnings).toBeUndefined();
    expect(result.config.gateway).toEqual({ port: reported ? 17777 : 16666 });
    expect(result.config.channels?.["nextcloud-talk"]).toEqual({
      enabled: true,
      ...workChannel(pin ? endpoint : undefined),
    });
    expect(result.changes.includes("installed repair")).toBe(reported);
    expect(result.changes).not.toContain("host repair");
    expect(config.gateway).toEqual({ port: 16666 });
  },
);

it("uses no-op eligibility without publishing unreported hook edits", async () => {
  const { update } = await fixture(["work"], { unreportedEdit: true });
  const config = channelConfig();
  const result = update(config);
  expect(result.warnings).toBeUndefined();
  expect(config).toEqual(channelConfig());
  expect(result.config).not.toHaveProperty("gateway");
  expect(result.config.channels?.["nextcloud-talk"]).toEqual(workChannel(endpoint));
});

it.each(["previous boot", "published updater"])(
  "backs up and pins a %s install once, then preserves a removed pin",
  async (evidence) => {
    const { configPath, env, migrate } = await fixture();
    const original = JSON.stringify(channelConfig());
    await fs.writeFile(configPath, original);
    if (evidence === "previous boot") {
      expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();
    }
    const io = createConfigIO({
      env,
      configPath,
      observe: false,
      pluginValidation: "skip",
      shellEnvFallback: "defer",
    });
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
    expect(snapshot.valid).toBe(true);
    const result = expectReads("gateway_boot_lifecycle", evidence === "previous boot" ? 1 : 0, () =>
      migrate(snapshot.sourceConfig, {
        ...env,
        ...(evidence === "published updater" ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {}),
      }),
    );
    expect(result.warnings).toBeUndefined();
    await replaceConfigFile({
      io,
      snapshot,
      nextConfig: result.config,
      writeOptions: { ...writeOptions, observe: false, skipPluginValidation: true },
    });
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
    const saved = await io.readConfigFileSnapshot({ observe: false });
    expect(saved.sourceConfig.channels?.["nextcloud-talk"]).toEqual(workChannel(endpoint));
    expect(saved.sourceConfig.meta?.migrations?.webhookListeners).toMatchObject({
      "nextcloud-talk": expect.any(Array),
    });
    await replaceConfigFile({
      io,
      snapshot: saved,
      nextConfig: { ...saved.sourceConfig, ...channelConfig() },
      writeOptions: { observe: false, skipPluginValidation: true },
    });
    const removedBytes = await fs.readFile(configPath, "utf8");
    const reloaded = await io.readConfigFileSnapshot({ observe: false });
    expectUnchanged(migrate(reloaded.sourceConfig), reloaded.sourceConfig);
    expect(await fs.readFile(configPath, "utf8")).toBe(removedBytes);
    expect(reloaded.sourceConfig.channels?.["nextcloud-talk"]).toEqual(workChannel());
  },
);

it.each(["no database", "empty database"])(
  "completes a fresh install with %s without pins even after its first Gateway boot",
  async (state) => {
    const { env, migrate } = await fixture();
    if (state === "empty database") {
      openOpenClawStateDatabase({ env });
      await closeStateDatabaseForTest();
    }
    const config = channelConfig();
    const fresh = migrate(config);
    expect(fresh.config.channels).toEqual(config.channels);
    expect(fresh.config.meta?.migrations?.webhookListeners).toBe(true);
    expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();
    expectUnchanged(migrate(fresh.config), fresh.config);
  },
);

it("keeps read-only completion when a managed config symlink selects a new generation", async () => {
  const { configPath, env, migrate } = await fixture();
  const readOnlyEnv = { ...env, OPENCLAW_CONFIG_READONLY: "1" };
  const config = channelConfig();
  const bytes = JSON.stringify(config);
  const firstGeneration = path.join(path.dirname(configPath), "generation-1.json");
  const nextGeneration = path.join(path.dirname(configPath), "generation-2.json");
  await fs.writeFile(firstGeneration, bytes);
  await fs.writeFile(nextGeneration, bytes);
  await fs.symlink(firstGeneration, configPath, "file");
  const fresh = migrate(config, readOnlyEnv);
  expect(fresh.config.meta?.migrations?.webhookListeners).toBe(true);
  expect(recordUnwrittenWebhookCompletion({ sourceConfig: config }, fresh, readOnlyEnv)).toBe(true);
  expectUnchanged(migrate(config, readOnlyEnv), config);
  expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();

  await fs.unlink(configPath);
  await fs.symlink(nextGeneration, configPath, "file");
  const redeployed: OpenClawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  expectUnchanged(migrate(redeployed, readOnlyEnv), redeployed);
  expect(await fs.readFile(firstGeneration, "utf8")).toBe(bytes);
  expect(await fs.readFile(nextGeneration, "utf8")).toBe(bytes);
});

it.each([
  { keys: ["work", "Work"], pinned: "work" },
  { keys: ["Work"], pinned: "Work" },
])("pins only the selected authored key: $keys", async ({ keys, pinned }) => {
  const { update } = await fixture();
  const accounts = Object.fromEntries(keys.map((key) => [key, { enabled: true }]));
  const result = update(channelConfig(accounts));
  expect(result.warnings).toBeUndefined();
  expect(result.config.channels?.["nextcloud-talk"]).toEqual({
    accounts: { ...accounts, [pinned]: { enabled: true, legacyWebhook: endpoint } },
  });
});

it("warns without publishing partial pins when an account alias is ambiguous", async () => {
  const { update } = await fixture(["unambiguous", "work"]);
  const config = channelConfig({ unambiguous: {}, Work: {}, WORK: {} });
  const result = update(config);
  expect(result.config).toEqual(config);
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([
    expect.stringContaining('Ambiguous nextcloud-talk account "work"'),
  ]);
  expect(result.warnings?.[0]).toContain('"Work", "WORK"');
  expect(result.warnings?.[0]).toContain(
    'channels.nextcloud-talk.accounts[<exact account key>].legacyWebhook = {"port":8788,"host":"0.0.0.0"}',
  );
});

it.each([false, { port: 9999 }])("preserves an explicit inherited endpoint: %j", async (pin) => {
  const { update } = await fixture();
  const config = {
    channels: { "nextcloud-talk": { legacyWebhook: pin, accounts: { work: {} } } },
  };
  const result = update(config);
  expect(result.config.channels).toEqual(config.channels);
  expect(result.config.meta?.migrations?.webhookListeners).toHaveProperty("nextcloud-talk");
});

it.each([
  { name: "endpoint", legacyWebhook: { port: 9397 } },
  { name: "opt-out", legacyWebhook: false as const },
  { name: "disabled channel", legacyWebhook: { port: 9397 }, enabled: false },
])("preserves authored Teams activation with $name", async ({ legacyWebhook, enabled }) => {
  const { update } = await fixture([undefined], {
    channelId: "msteams",
    preserveAuthoredActivation: true,
  });
  const result = update({
    channels: { msteams: { legacyWebhook, ...(enabled === undefined ? {} : { enabled }) } },
  });
  expect(result.warnings).toBeUndefined();
  expect(result.config.channels?.msteams).toEqual({ legacyWebhook, enabled: enabled ?? true });
  expect(result.config.meta?.migrations?.webhookListeners).toEqual({
    msteams: enabled === undefined ? [["channels", "msteams", "enabled"]] : [],
  });
});

it("does not turn an environment-only Teams pin into authored activation on a later Doctor run", async () => {
  const { update } = await fixture([undefined], {
    channelId: "msteams",
    preserveAuthoredActivation: true,
  });
  const first = update({});
  expect(first.config.channels?.msteams).toEqual({ legacyWebhook: { port: 3978 } });
  expectUnchanged(update(first.config), first.config);
});

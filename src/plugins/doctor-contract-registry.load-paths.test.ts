import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import type { OpenClawConfig } from "../config/types.js";
import { runPostSessionPluginDoctorStateRepairs } from "../infra/state-migrations.plugin-doctor.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  listPluginDoctorLegacyConfigRules,
  listPluginDoctorSessionRouteStateOwners,
  listPluginDoctorStateMigrationEntries,
} from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import { writeArtifacts as writeDoctorFiles } from "./public-surface.test-support.js";

const tempDirs = createTempDirTracker();

function writeDoctorFixture(
  pluginRoot: string,
  pluginId: string,
  files: Record<string, string | Record<string, unknown>>,
): void {
  const manifest = files["openclaw.plugin.json"];
  writeDoctorFiles(pluginRoot, {
    ...(files["package.json"] ? {} : { "index.cjs": "module.exports = {};\n" }),
    ...files,
    "openclaw.plugin.json": {
      id: pluginId,
      configSchema: {},
      ...(typeof manifest === "object" ? manifest : {}),
    },
  });
}

function writeDoctorPlugin(pluginRoot: string, pluginId: string): void {
  writeDoctorFixture(pluginRoot, pluginId, {
    "doctor-contract-api.cjs": `
const pluginId = ${JSON.stringify(pluginId)};
module.exports = {
  legacyConfigRules: [
    {
      path: ["plugins", "entries", pluginId, "config", "summaryModel"],
      message: "load-path doctor contract warning",
    },
  ],
  normalizeCompatibilityConfig({ cfg }) {
    const entry = cfg.plugins.entries[pluginId];
    entry.llm = { allowModelOverride: true, allowedModels: ["openai/gpt-5.4-mini"] };
    return {
      config: cfg,
      changes: ["configured load-path doctor contract LLM policy"],
    };
  },
};
`,
  });
}

function writeDistDoctorPlugin(pluginRoot: string, pluginId: string): void {
  writeDoctorFixture(pluginRoot, pluginId, {
    "package.json": distPackage(pluginId),
    "dist/index.js": "export {};\n",
    "dist/doctor-contract-api.cjs": commonJs({
      legacyConfigRules: [
        {
          path: ["plugins", "entries", pluginId, "config", "distOnly"],
          message: "dist doctor contract warning",
        },
      ],
    }),
  });
}

function commonJs(exports: Record<string, unknown>) {
  return `module.exports = ${JSON.stringify(exports)};\n`;
}

function distPackage(pluginId: string, version = "0.0.0-test") {
  return {
    name: `@openclaw/${pluginId}`,
    version,
    type: "module",
    openclaw: { extensions: ["./dist/index.js"] },
  };
}

function writeLegacyRuntimeDoctorPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  importedSymbols: readonly string[];
}): void {
  writeDoctorFixture(params.pluginRoot, params.pluginId, {
    "openclaw.plugin.json": { doctorContract: { configRepair: true } },
    "package.json": distPackage(params.pluginId, "2026.7.2-beta.7"),
    "dist/index.js": "export {};\n",
    "dist/doctor-contract-api.js": `import { ${params.importedSymbols.join(", ")} } from "openclaw/plugin-sdk/runtime-doctor";
const importedHelpers = [${params.importedSymbols.join(", ")}];
if (importedHelpers.some((helper) => typeof helper !== "function")) {
  throw new Error("legacy runtime-doctor helper missing");
}
export const legacyConfigRules = [{
  path: ["plugins", "entries", ${JSON.stringify(params.pluginId)}, "config", "legacyDoctor"],
  message: ${JSON.stringify(`${params.pluginId} legacy doctor contract loaded`)},
}];
`,
  });
}

function writeLegacyChannelMigrationPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  namespace: string;
  sourceFile: string;
  stateKey: string;
  label?: string;
}): void {
  writeDoctorFixture(params.pluginRoot, params.pluginId, {
    "openclaw.plugin.json": { channels: [params.pluginId] },
    "package.json": channelPackage(params.pluginId, true),
    "index.cjs": "throw new Error('legacy discovery loaded the channel runtime');\n",
    "doctor-contract-api.cjs": "module.exports = { legacyConfigRules: [] };\n",
    "setup-entry.cjs": `const fs = require('node:fs');
const path = require('node:path');
const pluginId = ${JSON.stringify(params.pluginId)};
const namespace = ${JSON.stringify(params.namespace)};
const sourceFile = ${JSON.stringify(params.sourceFile)};
const stateKey = ${JSON.stringify(params.stateKey)};
const label = ${JSON.stringify(params.label ?? `${params.pluginId} preserved channel state`)};
module.exports = {
  kind: 'bundled-channel-setup-entry',
  features: { legacyStateMigrations: true },
  loadSetupPlugin() {
    throw new Error('direct detector activated the setup plugin');
  },
  loadLegacyStateMigrationDetector() {
    return ({ stateDir }) => {
      const sourcePath = path.join(stateDir, pluginId, sourceFile);
      if (!fs.existsSync(sourcePath)) return [];
      return [{
        kind: 'plugin-state-import',
        label,
        sourcePath,
        targetPath: 'plugin state:' + namespace,
        pluginId,
        namespace,
        maxEntries: 1000,
        scopeKey: '',
        cleanupSource: 'rename',
        readEntries: () => [{ key: stateKey, value: JSON.parse(fs.readFileSync(sourcePath, 'utf8')) }],
      }];
    };
  },
};\n`,
  });
}

function channelPackage(pluginId: string, legacy = false) {
  return {
    name: `@openclaw/${pluginId}`,
    version: "2026.7.1",
    type: "commonjs",
    openclaw: {
      extensions: ["./index.cjs"],
      setupEntry: "./setup-entry.cjs",
      ...(legacy ? { setupFeatures: { legacyStateMigrations: true } } : {}),
    },
  };
}

function writeModernBundledChannelMigrationPlugin(pluginRoot: string, pluginId: string): void {
  writeDoctorFixture(pluginRoot, pluginId, {
    "openclaw.plugin.json": {
      channels: [pluginId],
      doctorContract: { stateMigrations: true },
    },
    "package.json": channelPackage(pluginId),
    "index.cjs": "throw new Error('shadowed bundled channel runtime loaded');\n",
    "setup-entry.cjs": "throw new Error('shadowed bundled setup entry loaded');\n",
    "doctor-contract-api.cjs": "throw new Error('shadowed bundled doctor contract loaded');\n",
  });
}

function writeLegacyPostSessionMigrationPlugin(pluginRoot: string, pluginId: string): void {
  writeDoctorFixture(pluginRoot, pluginId, {
    "openclaw.plugin.json": { doctorContract: { stateMigrations: true } },
    "doctor-contract-api.cjs": `module.exports = {
  stateMigrations: [{
    id: "legacy-post-session-state",
    label: "Legacy post-session state",
    doctorOnly: true,
    phase: "after-session-repair",
    detectLegacyState() {
      return { preview: ["legacy external post-session state is pending"] };
    },
    migrateLegacyState() {
      return { changes: ["migrated legacy external post-session state"], warnings: [] };
    },
  }],
};
`,
  });
}

function fixture(pluginId: string, write: (root: string, id: string) => void = () => {}) {
  const stateDir = tempDirs.make("openclaw-doctor-contract-load-paths-");
  const pluginRoot = tempDirs.make("openclaw-doctor-contract-load-paths-");
  write(pluginRoot, pluginId);
  return {
    stateDir,
    pluginRoot,
    config: {
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true, config: { summaryModel: "gpt-5.4-mini" } } },
      },
    } satisfies OpenClawConfig,
    env: {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    pluginIds: [pluginId],
  };
}

function migrationInput({ config, env, stateDir }: ReturnType<typeof fixture>) {
  return {
    config,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("legacy migration must use its canonical state owner");
      },
    },
  };
}

beforeEach(() => {
  clearPluginDoctorContractRegistryCache();
});

afterEach(() => {
  clearPluginDoctorContractRegistryCache();
  tempDirs.cleanup();
});

describe("doctor contract registry load-path plugins", () => {
  it.each([
    {
      pluginId: "telegram",
      namespace: "telegram.update-offsets",
      sourceFile: "update-offset-default.json",
      stateKey: "default",
      state: { version: 3, lastUpdateId: 731, botId: null, tokenFingerprint: null },
    },
    {
      pluginId: "discord",
      namespace: "thread-bindings",
      sourceFile: "thread-bindings.json",
      stateKey: "default:thread-123",
      state: {
        accountId: "default",
        threadId: "thread-123",
        channelId: "channel-123",
        targetSessionKey: "agent:main:discord:channel:thread-123",
      },
    },
  ])(
    "migrates real $pluginId state through a released external setup-entry contract",
    async ({ pluginId, namespace, sourceFile, stateKey, state }) => {
      const setup = fixture(pluginId, (pluginRoot) =>
        writeLegacyChannelMigrationPlugin({
          pluginRoot,
          pluginId,
          namespace,
          sourceFile,
          stateKey,
        }),
      );
      const { stateDir, config } = setup;
      const bundledPluginsDir = path.join(stateDir, "bundled");
      writeModernBundledChannelMigrationPlugin(path.join(bundledPluginsDir, pluginId), pluginId);
      const env = {
        ...setup.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
      const sourcePath = path.join(stateDir, pluginId, sourceFile);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, JSON.stringify(state), "utf8");

      const entries = listPluginDoctorStateMigrationEntries({ config, env, pluginIds: [pluginId] });
      expect(entries.map((entry) => entry.pluginId)).toEqual([pluginId]);
      const entry = entries[0];
      if (!entry) {
        throw new Error(`missing ${pluginId} released migration contract`);
      }
      expect(entry.migration.id).toBe(`${pluginId}-legacy-channel-state`);
      const input = migrationInput({ ...setup, env });
      await expect(entry.migration.detectLegacyState(input)).resolves.toEqual({
        preview: [`- ${pluginId} preserved channel state: ${sourcePath}`],
      });

      const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
        await import("../plugin-state/plugin-state-store.js");
      try {
        const result = await entry.migration.migrateLegacyState(input);
        expect(result.warnings).toEqual([]);
        expect(result.changes.length).toBeGreaterThan(0);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
        const store = createPluginStateKeyedStore(pluginId, { namespace, maxEntries: 1000, env });
        await expect(store.lookup(stateKey)).resolves.toEqual(state);
      } finally {
        resetPluginStateStoreForTests();
      }
    },
  );

  it("reloads a selected legacy setup entry after the plugin metadata lifecycle clears", async () => {
    const pluginId = "legacy-refresh";
    const setup = fixture(pluginId);
    const { stateDir, pluginRoot } = setup;
    const sourceFile = "refresh.json";
    const sourcePath = path.join(stateDir, pluginId, sourceFile);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "{}", "utf8");
    const writePlugin = (label: string) =>
      writeLegacyChannelMigrationPlugin({
        pluginRoot,
        pluginId,
        namespace: "legacy-refresh",
        sourceFile,
        stateKey: "default",
        label,
      });
    const detectPreview = async () => {
      const [entry] = listPluginDoctorStateMigrationEntries(setup);
      if (!entry) {
        throw new Error("missing selected legacy setup-entry migration");
      }
      return entry.migration.detectLegacyState(migrationInput(setup));
    };
    for (const label of ["Legacy refresh v1", "Legacy refresh v2"]) {
      writePlugin(label);
      clearPluginDoctorContractRegistryCache();
      await expect(detectPreview()).resolves.toEqual({ preview: [`- ${label}: ${sourcePath}`] });
    }
  });

  it.each([
    {
      pluginId: "load-path-doctor",
      write: writeDoctorPlugin,
      key: "summaryModel",
      prefix: "load-path",
    },
    { pluginId: "dist-doctor", write: writeDistDoctorPlugin, key: "distOnly", prefix: "dist" },
  ])("discovers $pluginId warning rules", ({ pluginId, write, key, prefix }) => {
    const input = fixture(pluginId, write);
    const rules = listPluginDoctorLegacyConfigRules(input);
    expect(rules).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", key],
        message: `${prefix} doctor contract warning`,
      },
    ]);
    if (key === "summaryModel") {
      expect(findLegacyConfigIssues(input.config, input.config, rules)).toEqual([
        {
          path: `plugins.entries.${pluginId}.config.summaryModel`,
          message: "load-path doctor contract warning",
        },
      ]);
      const result = applyPluginDoctorCompatibilityMigrations(input.config, input);
      expect(result.changes).toEqual(["configured load-path doctor contract LLM policy"]);
      expect(result.config.plugins?.entries?.[pluginId]).toHaveProperty("llm", {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      });
    }
  });

  it("loads preserved runtime-doctor exports from a released package contract", () => {
    const pluginId = "legacy-runtime-doctor";
    const input = fixture(pluginId, (pluginRoot) =>
      writeLegacyRuntimeDoctorPlugin({
        pluginRoot,
        pluginId,
        importedSymbols: [
          "archiveLegacyStateSource",
          "legacyStateFileExists",
          "asObjectRecord",
          "collectChannelAccountScopes",
          "collectProviderDangerousNameMatchingScopes",
          "defineChannelAliasMigration",
          "defineKeyMoveMigration",
          "hasLegacyAccountStreamingAliases",
          "normalizeChannelAccounts",
          "stripRetiredChannelKeys",
        ],
      }),
    );

    expect(listPluginDoctorLegacyConfigRules(input)).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", "legacyDoctor"],
        message: `${pluginId} legacy doctor contract loaded`,
      },
    ]);
  });

  it.each([
    {
      source: "manifest",
      owner: {
        id: "load-path-session-owner",
        label: "Load Path Session Owner",
        providerIds: ["load-path-provider"],
        runtimeIds: ["load-path-runtime"],
        cliSessionKeys: ["load-path-cli"],
        authProfilePrefixes: ["load-path:"],
      },
    },
    {
      source: "legacy module",
      owner: {
        id: "legacy-load-path-owner",
        label: "Legacy Load Path Owner",
        providerIds: ["legacy-provider"],
      },
    },
  ])("discovers $source session route-state owners from load paths", ({ source, owner }) => {
    const input = fixture(owner.id, (root, id) => {
      const owners = { sessionRouteStateOwners: [owner] };
      writeDoctorFixture(
        root,
        id,
        source === "manifest"
          ? { "openclaw.plugin.json": owners }
          : { "doctor-contract-api.cjs": commonJs(owners) },
      );
    });
    expect(listPluginDoctorSessionRouteStateOwners(input)).toEqual([
      { runtimeIds: [], cliSessionKeys: [], authProfilePrefixes: [], ...owner },
    ]);
  });

  it("validates frozen live post-session actions without applying candidate-only refusal", async () => {
    const pluginId = "legacy-post-session-owner";
    const { config, env } = fixture(pluginId, writeLegacyPostSessionMigrationPlugin);

    const unplanned = await runPostSessionPluginDoctorStateRepairs({ config, env });
    expect(unplanned.warnings).toContain("legacy external post-session state is pending");

    const planBound = await runPostSessionPluginDoctorStateRepairs({
      config,
      env,
      plannedActions: [],
    });
    expect(planBound).toMatchObject({
      changes: [],
      warnings: [expect.stringContaining("immutable action order")],
    });
    expect(planBound.warnings).not.toContain("legacy external post-session state is pending");
    const matchingPlan = await runPostSessionPluginDoctorStateRepairs({
      config,
      env,
      plannedActions: [{ pluginId, id: "legacy-post-session-state" }],
    });
    expect(matchingPlan.changes).toEqual([]);
    expect(matchingPlan.warnings).toContain("legacy external post-session state is pending");
  });
});

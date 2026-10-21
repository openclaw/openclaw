import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import type { PluginCandidate } from "./discovery.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  createInstalledPluginEnabledPredicate,
  isInstalledPluginEnabled,
  loadInstalledPluginIndex,
  loadInstalledPluginIndexWithDiscovery,
} from "./installed-plugin-index.js";
import { listAvailableManifestContractValues } from "./manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const PLUGIN_ID = "contract-provider";
const tempDirs: string[] = [];

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await closeStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function createFixture() {
  const stateDir = makeTrackedTempDir("openclaw-provider-compat-index", tempDirs);
  const pluginDir = path.join(stateDir, PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  const write = (file: string, text: string) => fs.writeFileSync(path.join(pluginDir, file), text);
  write("index.ts", "throw new Error('metadata must not load runtime');\n");
  write(
    "openclaw.plugin.json",
    JSON.stringify({
      id: PLUGIN_ID,
      enabledByDefault: true,
      configSchema: { type: "object" },
      contracts: { speechProviders: [PLUGIN_ID] },
    }),
  );
  const candidate: PluginCandidate = {
    idHint: PLUGIN_ID,
    source: path.join(pluginDir, "index.ts"),
    rootDir: pluginDir,
    origin: "bundled",
  };
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
  return {
    candidate,
    candidates: [candidate],
    env,
    stateDir,
    config: { plugins: { allow: ["listed"] } },
  };
}

function setMode(env: NodeJS.ProcessEnv, mode: "compat" | "allowlist") {
  writeConfigMachineState("plugins.bundledDiscovery", mode, { env });
  clearBundledDiscoveryModeMemo();
}

it("passes the caller environment through manifest validation", () => {
  const { candidate, env } = createFixture();
  const index = loadInstalledPluginIndex({
    candidates: [
      {
        ...candidate,
        origin: "global",
        packageDir: candidate.rootDir,
        packageManifest: {
          install: {
            npmSpec: "@openclaw/contract-provider",
            minHostVersion: ">=2099.1.1",
          },
        },
      },
    ],
    env: { ...env, OPENCLAW_VERSION: "2099.1.1" },
  });

  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual([PLUGIN_ID]);
});

it("applies fresh and dynamic policy to a contract-only provider", () => {
  const params = createFixture();
  const { config, env } = params;
  setMode(env, "compat");
  const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery(params);
  const listValues = () =>
    listAvailableManifestContractValues({
      snapshot: { index, plugins: manifestRegistry.plugins },
      contract: "speechProviders",
      config,
      env,
    });

  expect(index.plugins[0]?.enabled).toBe(true);
  expect(isInstalledPluginEnabled(index, PLUGIN_ID, config, env)).toBe(true);
  expect(listValues()).toEqual([PLUGIN_ID]);

  setMode(env, "allowlist");
  expect(isInstalledPluginEnabled(index, PLUGIN_ID, config, env)).toBe(false);
  expect(listValues()).toEqual([]);

  setMode(env, "compat");
  expect(listValues()).toEqual([PLUGIN_ID]);
  const denied = { plugins: { ...config.plugins, deny: [PLUGIN_ID] } };
  expect(isInstalledPluginEnabled(index, PLUGIN_ID, denied, env)).toBe(false);
});

it("keeps bundled compatibility separate from external policy in each batch", () => {
  const params = createFixture();
  const { config, env } = params;
  setMode(env, "compat");
  const index = loadInstalledPluginIndex(params);
  const plugins = [
    ...index.plugins,
    ...index.plugins.map((record) =>
      Object.assign({}, record, { pluginId: "external-tool", origin: "global" as const }),
    ),
  ];
  const compatible = createInstalledPluginEnabledPredicate(plugins, config, env);
  const check = (predicate: (id: string) => boolean, expected: boolean[]) =>
    expect(["external-tool", PLUGIN_ID, "external-tool"].map(predicate)).toEqual(expected);
  check(compatible, [false, true, false]);

  config.plugins.allow.push("external-tool");
  const reconfigured = createInstalledPluginEnabledPredicate(plugins, config, env);
  check(reconfigured, [true, true, true]);

  setMode(env, "allowlist");
  const strict = createInstalledPluginEnabledPredicate(plugins, config, env);
  check(strict, [true, false, true]);
});

it("refreshes persisted contract-only provider policy without rebuilding source records", async () => {
  const { candidates, ...params } = createFixture();
  const { env } = params;
  setMode(env, "compat");
  const initial = await refreshPersistedInstalledPluginIndex({
    ...params,
    reason: "manual",
    candidates,
  });
  expect(initial.plugins[0]?.enabled).toBe(true);
  for (const mode of ["allowlist", "compat"] as const) {
    setMode(env, mode);
    const refreshed = await refreshPersistedInstalledPluginIndex({
      ...params,
      reason: "policy-changed",
      policyPluginIds: [PLUGIN_ID],
    });
    expect(refreshed.plugins[0]?.enabled).toBe(mode === "compat");
  }
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import type { PluginCandidate } from "./discovery.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  createInstalledPluginEnabledPredicate,
  isInstalledPluginEnabled,
  loadInstalledPluginIndexWithDiscovery,
} from "./installed-plugin-index.js";
import { writeFixtureJson } from "./loader-fixture-builders.test-support.js";
import { listAvailableManifestContractValues } from "./manifest-contract-eligibility.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const PLUGIN_ID = "contract-provider";
afterEach(clearPluginMetadataLifecycleCaches);
const tempDirs = useStateDatabaseTempDirs();

function createFixture() {
  const stateDir = tempDirs.make("openclaw-provider-compat-index-");
  const pluginDir = path.join(stateDir, PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  const write = (file: string, text: string) => fs.writeFileSync(path.join(pluginDir, file), text);
  write("index.ts", "throw new Error('metadata must not load runtime');\n");
  writeFixtureJson(pluginDir, "openclaw.plugin.json", {
    id: PLUGIN_ID,
    enabledByDefault: true,
    configSchema: { type: "object" },
    contracts: { speechProviders: [PLUGIN_ID] },
  });
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

it("owns captured install metadata while keeping host eligibility separate within a generation", async () => {
  const { candidate, env } = createFixture();
  writeFixtureJson(candidate.rootDir, "package.json", {
    name: "@openclaw/contract-provider",
    openclaw: { extensions: ["./index.ts"], install: { minHostVersion: ">=2099.1.1" } },
  });
  const config = captureRuntimeConfig({ plugins: { load: { paths: [candidate.rootDir] } } });
  const metadata = { note: "original" };
  const installRecords = {
    [PLUGIN_ID]: { source: "path" as const, installPath: candidate.rootDir, metadata },
  };
  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    const snapshots = ["2098.1.1", "2099.1.1", "2098.1.1"].map((version) =>
      loadPluginMetadataSnapshot({
        config,
        env: { ...env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_VERSION: version },
        installRecords,
      }),
    );
    expect(snapshots.map(({ index }) => index.plugins.map(({ pluginId }) => pluginId))).toEqual([
      [],
      [PLUGIN_ID],
      [],
    ]);
    metadata.note = "edited by caller";
    expect(snapshots[0]?.index.installRecords[PLUGIN_ID]).toMatchObject({
      metadata: { note: "original" },
    });
  });
});

it("applies dynamic policy without leaking bundled compatibility to external plugins", () => {
  const params = createFixture();
  const { config, env } = params;
  setMode(env, "compat");
  const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery(params);
  const plugins = [
    ...index.plugins,
    ...index.plugins.map((record) => ({
      ...record,
      pluginId: "external-tool",
      origin: "global" as const,
    })),
  ];
  const check = (bundled: boolean, external: boolean) => {
    expect(isInstalledPluginEnabled(index, PLUGIN_ID, config, env)).toBe(bundled);
    expect(
      listAvailableManifestContractValues({
        snapshot: { index, plugins: manifestRegistry.plugins },
        contract: "speechProviders",
        config,
        env,
      }),
    ).toEqual(bundled ? [PLUGIN_ID] : []);
    expect(
      ["external-tool", PLUGIN_ID, "external-tool"].map(
        createInstalledPluginEnabledPredicate(plugins, config, env),
      ),
    ).toEqual([external, bundled, external]);
  };
  expect(index.plugins[0]?.enabled).toBe(true);
  check(true, false);
  config.plugins.allow.push("external-tool");
  check(true, true);
  setMode(env, "allowlist");
  check(false, true);
  setMode(env, "compat");
  check(true, true);
  const denied = { plugins: { ...config.plugins, deny: [PLUGIN_ID] } };
  expect(isInstalledPluginEnabled(index, PLUGIN_ID, denied, env)).toBe(false);
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

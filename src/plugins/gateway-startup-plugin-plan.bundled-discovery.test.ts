// Covers gateway-startup plan activation under bundledDiscovery machine state.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./channel-plugin-ids.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

function buildStartupFixture() {
  const records: InstalledPluginIndexRecord[] = ["openai", "browser"].map((pluginId) => {
    const rootDir = `/tmp/plugins/${pluginId}`;
    return {
      pluginId,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      manifestHash: `${pluginId}-manifest`,
      rootDir,
      origin: "bundled",
      enabled: true,
      enabledByDefault: true,
      startup: {
        sidecar: true,
        memory: false,
        agentHarnesses: [],
        configPaths: [],
      },
      contributions: {
        channels: [],
        channelConfigs: [],
        providers: pluginId === "openai" ? ["openai"] : [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    };
  });
  const index: PluginRegistrySnapshot = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: records,
    diagnostics: [],
  };
  const manifestRegistry: PluginManifestRegistry = {
    plugins: ["openai", "browser"].map((id) => ({
      id,
      origin: "bundled",
      enabledByDefault: true,
      activation: { onStartup: true },
      providers: id === "openai" ? ["openai"] : [],
      channels: [],
      cliBackends: [],
      rootDir: `/tmp/plugins/${id}`,
      source: `/tmp/plugins/${id}/index.ts`,
      manifestPath: `/tmp/plugins/${id}/openclaw.plugin.json`,
      skills: [],
      hooks: [],
    })),
    diagnostics: [],
  };
  return { index, manifestRegistry };
}

describe("gateway startup plan under bundledDiscovery compat", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("keeps provider owners while omitted non-providers remain strict", async () => {
    // Two-root regression (#123416): the plan's default-startup fallback must
    // read compat from the plan env, not the process root.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const { index, manifestRegistry } = buildStartupFixture();
      // Sanity: without an allowlist both default-enabled plugins can start.
      expect(
        resolveGatewayStartupPluginPlanFromRegistry({
          config: {},
          env: { ...process.env },
          index,
          manifestRegistry,
        }).pluginIds,
      ).toEqual(["openai", "browser"]);
      const config = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        plugins: { allow: ["some-other-plugin"] },
      };
      const planEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };

      const compatPlan = resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: planEnv,
        index,
        manifestRegistry,
      }).pluginIds;
      expect(compatPlan).toContain("openai");
      expect(compatPlan).not.toContain("browser");
      // Process root has no recorded mode: strict allowlist gate stands.
      const strictPlan = resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: { ...process.env },
        index,
        manifestRegistry,
      }).pluginIds;
      expect(strictPlan).not.toContain("openai");
      expect(strictPlan).not.toContain("browser");
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await removeBundledDiscoveryStateRoot(compatRoot);
      await removeBundledDiscoveryStateRoot(plainRoot);
    }
  });
});

describe("release image runtime proof activation", () => {
  it("activates installed UI channel owners without starting their transports", () => {
    const installed = ["x", "workboard"].map((id) => ({
      metadata: JSON.parse(
        readFileSync(
          new URL(`../../extensions/${id}/openclaw.plugin.json`, import.meta.url),
          "utf8",
        ),
      ) as Pick<PluginManifestRecord, "id" | "channels" | "activation">,
    }));
    const source = readFileSync(
      new URL("../../scripts/e2e/lib/artifact-permissions/runtime-proof.mjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("writeFileSync(\n  env.OPENCLAW_CONFIG_PATH,");
    const end = source.indexOf("\nconst gateway = spawn", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let config: OpenClawConfig | undefined;
    runInNewContext(source.slice(start, end), {
      env: { OPENCLAW_CONFIG_PATH: "/synthetic/openclaw.json" },
      port: 18789,
      token: "synthetic-runtime-proof-token",
      installed,
      writeFileSync: (_file: string, body: string) => {
        config = JSON.parse(body) as OpenClawConfig;
      },
    });
    const { index, manifestRegistry } = buildStartupFixture();
    installed.forEach(({ metadata }, position) => {
      const record = index.plugins[position]!;
      record.pluginId = metadata.id;
      record.startup.sidecar = metadata.activation?.onStartup === true;
      record.contributions!.channels = metadata.channels ?? [];
      record.contributions!.providers = [];
      manifestRegistry.plugins[position] = {
        ...manifestRegistry.plugins[position]!,
        ...metadata,
        channels: metadata.channels ?? [],
        providers: [],
      };
    });
    const startup = (cfg: OpenClawConfig) =>
      resolveGatewayStartupPluginPlanFromRegistry({
        config: cfg,
        env: { OPENCLAW_SKIP_CHANNELS: "1" },
        index,
        manifestRegistry,
      }).pluginIds;
    expect(config).toBeDefined();
    if (!config) {
      throw new Error("Runtime proof did not create synthetic config");
    }
    expect(startup({ ...config, channels: undefined })).not.toContain("x");
    expect(startup(config)).toEqual(expect.arrayContaining(["x", "workboard"]));
    expect(config.channels).toEqual({ x: { enabled: true } });
  });
});

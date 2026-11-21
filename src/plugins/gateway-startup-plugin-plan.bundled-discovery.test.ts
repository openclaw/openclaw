import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./channel-plugin-ids.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

function buildStartupFixture() {
  const manifestRegistry: PluginManifestRegistry = {
    plugins: ["openai", "browser"].map((id) =>
      createPluginManifestRecordFixture({
        id,
        enabledByDefault: true,
        activation: { onStartup: true },
        providers: id === "openai" ? ["openai"] : [],
        rootDir: `/tmp/plugins/${id}`,
        source: `/tmp/plugins/${id}/index.ts`,
      }),
    ),
    diagnostics: [],
  };
  return { index: createInstalledPluginIndexFixture(manifestRegistry), manifestRegistry };
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

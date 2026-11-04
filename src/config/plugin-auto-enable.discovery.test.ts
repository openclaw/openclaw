import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  resolveGatewayReloadPluginActivationCandidate,
  resolveGatewayStartupPluginActivationConfig,
} from "../gateway/plugin-activation-runtime-config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(() => cleanupPluginLoaderFixturesForTest());

it.each([
  { name: "disabled", plugins: { entries: { myprov: { enabled: false } } }, enabled: false },
  { name: "enabled", plugins: { entries: { myprov: { enabled: true } } }, enabled: true },
  { name: "denied", plugins: { deny: [" MYPROV "] }, enabled: false },
  { name: "globally disabled", plugins: { enabled: false }, enabled: false },
  { name: "auto-enabled", plugins: {}, enabled: true },
])(
  "preserves $name policy through disk discovery and runtime registration",
  ({ name, plugins, enabled }) => {
    useNoBundledPlugins();
    vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
    const plugin = writePlugin({
      id: "MyProv",
      registration: 'api.registerProvider({ id: "myprov", label: "fixture", auth: [] });',
    });
    const manifestFile = path.join(plugin.dir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifest,
        providers: ["myprov"],
        autoEnableWhenConfiguredProviders: ["myprov"],
      }),
    );
    const configFile = path.join(plugin.dir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        auth: { profiles: { fixture: { provider: "myprov", mode: "api_key" } } },
        plugins: { load: { paths: [plugin.file] }, ...plugins },
      }),
    );
    const config: OpenClawConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const result = applyPluginAutoEnable({ config, env: process.env });
    const registry = loadOpenClawPlugins({
      config: result.config,
      activationSourceConfig: config,
      autoEnabledReasons: result.autoEnabledReasons,
      cache: false,
    });
    expect(registry.plugins.find((entry) => entry.id === "MyProv")?.status).toBe(
      enabled ? "loaded" : "disabled",
    );
    expect(registry.providers.map(({ provider }) => provider.id)).toEqual(
      enabled ? ["myprov"] : [],
    );
    const expectedEntries =
      name === "auto-enabled" ? { myprov: { enabled: true } } : config.plugins?.entries;
    expect(result.config.plugins?.entries).toEqual(expectedEntries);
    // These production consumers must derive the same policy from the authored source, not a repaired copy.
    const reload = resolveGatewayReloadPluginActivationCandidate({
      sourceConfig: config,
      env: process.env,
    });
    const startup = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: config,
      activationSourceConfig: config,
      env: process.env,
    });
    const runtime = resolvePluginRuntimeLoadContext({ config, env: process.env });
    for (const candidate of [reload, startup, runtime.config]) {
      expect(candidate.plugins?.entries).toEqual(expectedEntries);
    }
  },
);

// Covers which plugin ids are worth loading a setup module for during auto-enable detection.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const setupRegistryMock = vi.hoisted(() => ({
  resolvePluginSetupAutoEnableReasons: vi.fn(
    (params: { config?: OpenClawConfig; pluginIds?: readonly string[] }) => {
      const pluginIds = new Set(params.pluginIds ?? []);
      const browserEntry = params.config?.plugins?.entries?.browser;
      const hasBrowserEntry =
        browserEntry && typeof browserEntry === "object" && browserEntry.enabled !== false;
      return pluginIds.has("browser") && hasBrowserEntry
        ? [{ pluginId: "browser", reason: "browser plugin configured" }]
        : [];
    },
  ),
}));

vi.mock("../plugins/setup-registry.js", () => ({
  clearPluginSetupRegistryCache: vi.fn(),
  resolvePluginSetupAutoEnableReasons: setupRegistryMock.resolvePluginSetupAutoEnableReasons,
}));

const env = makeIsolatedEnv();
const emptyDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

function probedPluginIds(): string[] {
  return setupRegistryMock.resolvePluginSetupAutoEnableReasons.mock.calls.flatMap(([params]) => [
    ...(params.pluginIds ?? []),
  ]);
}

afterAll(() => {
  resetPluginAutoEnableTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin auto-enable setup probes", () => {
  it("skips probes whose auto-enable candidate materialization discards", () => {
    setupRegistryMock.resolvePluginSetupAutoEnableReasons.mockClear();
    const manifestRegistry = makeRegistry([
      { id: "browser", channels: [] },
      { id: "acpx", channels: [] },
      { id: "denied-plugin", channels: [] },
    ]);
    const config: OpenClawConfig = {
      plugins: {
        deny: ["denied-plugin"],
        entries: {
          // Already enabled: materialization drops its candidate, so the probe is wasted work.
          acpx: { enabled: true, config: {} },
          // Denied ids are dropped everywhere in materialization, including prefer-over.
          "denied-plugin": { config: {} },
          // Not enabled yet: its probe result can still change runtime config.
          browser: { config: {} },
        },
      },
    };

    applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });

    expect(probedPluginIds()).not.toContain("acpx");
    expect(probedPluginIds()).not.toContain("denied-plugin");
    expect(probedPluginIds()).toContain("browser");
  });

  it("still probes an enabled plugin that a restrictive allowlist excludes", () => {
    setupRegistryMock.resolvePluginSetupAutoEnableReasons.mockClear();
    const manifestRegistry = makeRegistry([{ id: "browser", channels: [] }]);
    const config: OpenClawConfig = {
      plugins: {
        allow: ["other-plugin"],
        entries: {
          browser: { enabled: true, config: {} },
        },
      },
    };

    const result = applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });

    expect(probedPluginIds()).toContain("browser");
    // The probe is what keeps the allowlist from dropping the configured entry.
    expect(result.config.plugins?.allow).toContain("browser");
  });

  it("still probes an enabled plugin that prefers over another candidate", () => {
    setupRegistryMock.resolvePluginSetupAutoEnableReasons.mockClear();
    const manifestRegistry = makeRegistry([
      { id: "browser", channels: [] },
      {
        id: "acpx",
        channels: [],
        channelConfigs: { acpx: { schema: {}, preferOver: ["browser"] } },
      },
    ]);
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          acpx: { enabled: true, config: {} },
          browser: { config: {} },
        },
      },
    };

    applyPluginAutoEnable({
      config,
      discovery: emptyDiscovery,
      env,
      manifestRegistry,
    });

    // Prefer-over ordering is resolved across the whole candidate set, so this
    // plugin's candidate must survive even though it is already enabled.
    expect(probedPluginIds()).toContain("acpx");
  });
});

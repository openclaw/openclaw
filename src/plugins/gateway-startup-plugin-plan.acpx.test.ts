import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materializePluginAutoEnableCandidates } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";

function loadBundledManifest(pluginId: string) {
  const result = loadPluginManifest(
    fileURLToPath(new URL(`../../extensions/${pluginId}/`, import.meta.url)),
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.manifest;
}

const acpxManifest = loadBundledManifest("acpx");
const codexManifest = loadBundledManifest("codex");

function createManifestRegistry(
  plugin: Pick<PluginManifestRecord, "id" | "enabledByDefault" | "activation" | "contracts">,
): PluginManifestRegistry {
  return {
    plugins: [
      {
        origin: "bundled",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/fixture/${plugin.id}`,
        source: `/fixture/${plugin.id}/index.ts`,
        manifestPath: `/fixture/${plugin.id}/openclaw.plugin.json`,
        ...plugin,
      },
    ],
    diagnostics: [],
  };
}

const manifestRegistry = createManifestRegistry(acpxManifest);

describe("auto-enabled plugin startup", () => {
  it.each<{
    name: string;
    acp?: OpenClawConfig["acp"];
    plugins?: OpenClawConfig["plugins"];
    expected: string[];
  }>([
    { name: "no ACP key", expected: ["acpx"] },
    { name: "explicitly enabled", acp: { enabled: true }, expected: ["acpx"] },
    {
      name: "documented baseline",
      acp: {
        enabled: true,
        dispatch: { enabled: true },
        backend: "acpx",
        defaultAgent: "codex",
        allowedAgents: ["claude", "codex"],
        stream: { deliveryMode: "live" },
      },
      expected: ["acpx"],
    },
    { name: "explicitly disabled", acp: { enabled: false }, expected: ["acpx"] },
    {
      name: "ACP enabled but acpx excluded from the allowlist",
      acp: { enabled: true },
      plugins: { allow: ["other"] },
      expected: [],
    },
    {
      name: "ACP enabled and acpx included in the allowlist",
      acp: { enabled: true },
      plugins: { allow: ["other", "acpx"] },
      expected: ["acpx"],
    },
    {
      name: "ACP enabled but acpx denied",
      acp: { enabled: true },
      plugins: { deny: ["acpx"] },
      expected: [],
    },
    {
      name: "ACP enabled but acpx explicitly disabled",
      acp: { enabled: true },
      plugins: { entries: { acpx: { enabled: false } } },
      expected: [],
    },
  ])("plans the expected plugin with $name", ({ acp, plugins, expected }) => {
    const activationSourceConfig: OpenClawConfig = { ...(acp ? { acp } : {}), plugins };
    const { config } = materializePluginAutoEnableCandidates({
      config: activationSourceConfig,
      candidates:
        acp?.enabled === true
          ? [{ pluginId: "acpx", kind: "setup-auto-enable", reason: "ACP runtime configured" }]
          : [],
      env: {},
      manifestRegistry,
    });
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        activationSourceConfig,
        env: {},
        index: createInstalledPluginIndexFixture(manifestRegistry),
        manifestRegistry,
      }).pluginIds,
    ).toEqual(expected);
  });

  it.each([
    {
      name: "a default-disabled startup plugin",
      plugin: { id: "optional", enabledByDefault: false, activation: { onStartup: true } },
      activationSourceConfig: {},
      expected: [],
    },
    {
      name: "a default-enabled plugin without a startup trigger",
      plugin: { id: "lazy", enabledByDefault: true, activation: { onStartup: false } },
      activationSourceConfig: {},
      expected: [],
    },
    {
      name: "Codex with a configured harness",
      plugin: codexManifest,
      activationSourceConfig: {
        agents: { defaults: { models: { "openai/gpt-test": { agentRuntime: { id: "codex" } } } } },
      },
      expected: ["codex"],
    },
    {
      name: "an enabled Codex tool owner without a configured harness",
      plugin: codexManifest,
      activationSourceConfig: {},
      expected: ["codex"],
    },
  ])("preserves startup eligibility for $name", ({ plugin, activationSourceConfig, expected }) => {
    const registry = createManifestRegistry(plugin);
    const config = materializePluginAutoEnableCandidates({
      config: activationSourceConfig,
      candidates: [
        { pluginId: plugin.id, kind: "agent-harness-runtime-configured", runtime: "codex" },
      ],
      env: {},
      manifestRegistry: registry,
    }).config;
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        activationSourceConfig,
        env: {},
        index: createInstalledPluginIndexFixture(registry),
        manifestRegistry: registry,
      }).pluginIds,
    ).toEqual(expected);
  });
});

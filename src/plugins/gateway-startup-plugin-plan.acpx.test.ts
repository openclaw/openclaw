import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materializePluginAutoEnableCandidates } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

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
      createPluginManifestRecordFixture({
        rootDir: `/fixture/${plugin.id}`,
        source: `/fixture/${plugin.id}/index.ts`,
        ...plugin,
      }),
    ],
    diagnostics: [],
  };
}

const manifestRegistry = createManifestRegistry(acpxManifest);

function plan(
  activationSourceConfig: OpenClawConfig,
  registry: PluginManifestRegistry,
  candidates: Parameters<typeof materializePluginAutoEnableCandidates>[0]["candidates"],
) {
  const { config } = materializePluginAutoEnableCandidates({
    config: activationSourceConfig,
    candidates,
    env: {},
    manifestRegistry: registry,
  });
  return resolveGatewayStartupPluginPlanFromRegistry({
    config,
    activationSourceConfig,
    env: {},
    index: createInstalledPluginIndexFixture(registry),
    manifestRegistry: registry,
  }).pluginIds;
}

describe("auto-enabled plugin startup", () => {
  it.each<[string, OpenClawConfig, string[]]>([
    ["no ACP key", {}, ["acpx"]],
    ["explicitly enabled", { acp: { enabled: true } }, ["acpx"]],
    ["explicitly disabled", { acp: { enabled: false } }, ["acpx"]],
    ["acpx excluded from allowlist", { acp: { enabled: true }, plugins: { allow: ["other"] } }, []],
    [
      "acpx included in allowlist",
      { acp: { enabled: true }, plugins: { allow: ["other", "acpx"] } },
      ["acpx"],
    ],
    ["acpx denied", { acp: { enabled: true }, plugins: { deny: ["acpx"] } }, []],
    [
      "acpx explicitly disabled",
      { acp: { enabled: true }, plugins: { entries: { acpx: { enabled: false } } } },
      [],
    ],
  ])("plans the expected plugin with %s", (_name, activationSourceConfig, expected) => {
    expect(
      plan(
        activationSourceConfig,
        manifestRegistry,
        activationSourceConfig.acp?.enabled === true
          ? [{ pluginId: "acpx", kind: "setup-auto-enable", reason: "ACP runtime configured" }]
          : [],
      ),
    ).toEqual(expected);
  });

  it.each<[string, Parameters<typeof createManifestRegistry>[0], OpenClawConfig, string[]]>([
    [
      "a default-disabled startup plugin",
      { id: "optional", enabledByDefault: false, activation: { onStartup: true } },
      {},
      [],
    ],
    [
      "a default-enabled plugin without a startup trigger",
      { id: "lazy", enabledByDefault: true, activation: { onStartup: false } },
      {},
      [],
    ],
    [
      "Codex with a configured harness",
      codexManifest,
      {
        agents: { defaults: { models: { "openai/gpt-test": { agentRuntime: { id: "codex" } } } } },
      },
      ["codex"],
    ],
    ["an enabled Codex tool owner without a configured harness", codexManifest, {}, ["codex"]],
  ])("preserves startup eligibility for %s", (_name, plugin, activationSourceConfig, expected) => {
    const registry = createManifestRegistry(plugin);
    expect(
      plan(activationSourceConfig, registry, [
        { pluginId: plugin.id, kind: "agent-harness-runtime-configured", runtime: "codex" },
      ]),
    ).toEqual(expected);
  });
});

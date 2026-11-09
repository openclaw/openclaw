import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const OWNERS = [
  { id: "search-owner", contract: "webSearchProviders", envVar: "SEARCH_OWNER_API_KEY" },
  { id: "speech-owner", contract: "speechProviders", envVar: "SPEECH_OWNER_API_KEY" },
] as const;

function fixture() {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: OWNERS.map(({ id, contract, envVar }) => ({
      id,
      enabledByDefault: true,
      contracts: { [contract]: [id] },
      setup: { providers: [{ id, envVars: [envVar] }] },
    })),
  });
  for (const [index, { id, contract }] of OWNERS.entries()) {
    snapshot.index.plugins[index]!.contributions = {
      channels: [],
      channelConfigs: [],
      providers: [],
      modelCatalogProviders: [],
      modelSupportPrefixes: [],
      modelSupportPatterns: [],
      autoEnableProviderIds: [],
      commandAliases: [],
      contracts: { [contract]: [id] },
    };
  }
  return snapshot;
}

const BOTH_KEYS = { SEARCH_OWNER_API_KEY: "search-key", SPEECH_OWNER_API_KEY: "speech-key" };

describe("credentialed auto-selected capability owners", () => {
  // Auto-selection only sees loaded owners, so a present credential must load its owner.
  it.each<{ name: string; config: OpenClawConfig; env: NodeJS.ProcessEnv; expected: string[] }>([
    {
      name: "a credential is present",
      config: {},
      env: BOTH_KEYS,
      expected: ["search-owner", "speech-owner"],
    },
    { name: "no credential is present", config: {}, env: {}, expected: [] },
    {
      name: "providers are pinned elsewhere",
      config: { tools: { web: { search: { provider: "other" } } }, tts: { provider: "other" } },
      env: BOTH_KEYS,
      expected: [],
    },
    {
      name: "the capability is disabled",
      config: { tools: { web: { search: { enabled: false } } } },
      env: { SEARCH_OWNER_API_KEY: "search-key" },
      expected: [],
    },
    {
      name: "the owner is explicitly disabled",
      config: { plugins: { entries: { "search-owner": { enabled: false } } } },
      env: { SEARCH_OWNER_API_KEY: "search-key" },
      expected: [],
    },
  ])("starts owners only when $name", ({ config, env, expected }) => {
    const metadata = fixture();
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env,
        index: metadata.index,
        manifestRegistry: metadata.manifestRegistry,
      }).pluginIds,
    ).toEqual(expected);
  });
});

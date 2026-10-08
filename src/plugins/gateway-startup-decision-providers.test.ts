import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupMetadataPluginIds } from "./gateway-startup-plugin-metadata.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

function fixture() {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "decision-plugin",
        enabledByDefault: false,
        contracts: { decisionProviders: ["decision-provider"] },
      },
      { id: "allowed-plugin" },
    ],
  });
  snapshot.index.plugins[0]!.contributions = {
    channels: [],
    channelConfigs: [],
    providers: [],
    modelCatalogProviders: [],
    modelSupportPrefixes: [],
    modelSupportPatterns: [],
    autoEnableProviderIds: [],
    commandAliases: [],
    contracts: { decisionProviders: ["decision-provider"] },
  };
  return snapshot;
}

describe("decision provider startup", () => {
  it.each<{ name: string; config: OpenClawConfig; expected: string[] }>([
    { name: "unselected", config: {}, expected: [] },
    {
      name: "selected by an agent override",
      config: { agents: { entries: { specialist: { decisionModel: "decision-provider/fast" } } } },
      expected: ["decision-plugin"],
    },
    {
      name: "selected by defaults without a chat model",
      config: { agents: { defaults: { decisionModel: "decision-provider/fast" } } },
      expected: ["decision-plugin"],
    },
    {
      name: "selected through a configured endpoint alias",
      config: {
        agents: { defaults: { decisionModel: "judge/fast" } },
        models: {
          providers: {
            judge: {
              type: "decision",
              decisionProvider: "decision-provider",
              baseUrl: "https://decision.example.test",
              models: [
                {
                  id: "fast",
                  name: "Fast",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1,
                },
              ],
            },
          },
        },
      },
      expected: ["decision-plugin"],
    },
    {
      name: "explicitly disabled",
      config: {
        agents: { defaults: { decisionModel: "decision-provider/fast" } },
        plugins: { entries: { "decision-plugin": { enabled: false } } },
      },
      expected: [],
    },
  ])("loads the configured owner when $name", ({ config, expected }) => {
    const metadata = fixture();
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: {},
        index: metadata.index,
        manifestRegistry: metadata.manifestRegistry,
      }).pluginIds,
    ).toEqual(expected);
  });

  it("maps per-agent provider IDs through contract ownership in metadata scopes", () => {
    expect(
      resolveGatewayStartupMetadataPluginIds({
        config: {
          agents: { entries: { specialist: { decisionModel: "decision-provider/fast" } } },
          plugins: { allow: ["allowed-plugin"], slots: { memory: "none" } },
        },
        env: {},
        index: fixture().index,
      }),
    ).toEqual(["allowed-plugin", "decision-plugin"]);
  });

  it("maps configured endpoint aliases to adapter owners in metadata scopes", () => {
    expect(
      resolveGatewayStartupMetadataPluginIds({
        config: {
          agents: { defaults: { decisionModel: "judge/fast" } },
          models: {
            providers: {
              judge: {
                type: "decision",
                decisionProvider: "decision-provider",
                baseUrl: "https://decision.example.test",
                models: [],
              },
            },
          },
          plugins: { allow: ["allowed-plugin"], slots: { memory: "none" } },
        },
        env: {},
        index: fixture().index,
      }),
    ).toEqual(["allowed-plugin", "decision-plugin"]);
  });
});

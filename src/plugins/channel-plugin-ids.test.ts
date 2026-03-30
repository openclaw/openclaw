import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../channels/config-presence.js", () => ({
  listPotentialConfiguredChannelIds,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import { resolveGatewayStartupPluginIds } from "./channel-plugin-ids.js";

function createManifestRegistryFixture() {
  return {
    plugins: [
      {
        id: "demo-channel",
        channels: ["demo-channel"],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-default-on-sidecar",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-provider-plugin",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: ["demo-provider"],
        cliBackends: ["demo-cli"],
      },
      {
        id: "demo-bundled-sidecar",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-global-sidecar",
        channels: [],
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
    ],
    diagnostics: [],
  };
}

function expectStartupPluginIds(config: OpenClawConfig, expected: readonly string[]) {
  expect(
    resolveGatewayStartupPluginIds({
      config,
      workspaceDir: "/tmp",
      env: process.env,
    }),
  ).toEqual(expected);
  expect(loadPluginManifestRegistry).toHaveBeenCalled();
}

function expectStartupPluginIdsCase(params: {
  config: OpenClawConfig;
  expected: readonly string[];
}) {
  expectStartupPluginIds(params.config, params.expected);
}

function createStartupConfig(params: {
  enabledPluginIds?: string[];
  providerIds?: string[];
  modelId?: string;
}) {
  return {
    ...(params.enabledPluginIds?.length
      ? {
          plugins: {
            entries: Object.fromEntries(
              params.enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
            ),
          },
        }
      : {}),
    ...(params.providerIds?.length
      ? {
          models: {
            providers: Object.fromEntries(
              params.providerIds.map((providerId) => [
                providerId,
                {
                  baseUrl: "https://example.com",
                  models: [],
                },
              ]),
            ),
          },
        }
      : {}),
    ...(params.modelId
      ? {
          agents: {
            defaults: {
              model: { primary: params.modelId },
              models: {
                [params.modelId]: {},
              },
            },
          },
        }
      : {}),
  } as OpenClawConfig;
}

describe("resolveGatewayStartupPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockReturnValue(["demo-channel"]);
    loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistryFixture());
  });

  it.each([
    [
      "includes configured channels, explicit bundled sidecars, and enabled non-bundled sidecars",
      createStartupConfig({
        enabledPluginIds: ["demo-bundled-sidecar"],
        modelId: "demo-cli/demo-model",
      }),
      [
        "demo-channel",
        "demo-default-on-sidecar",
        "demo-provider-plugin",
        "demo-bundled-sidecar",
        "demo-global-sidecar",
      ],
    ],
    [
      "includes bundled plugins with enabledByDefault: true",
      {} as OpenClawConfig,
      ["demo-channel", "demo-default-on-sidecar", "demo-global-sidecar"],
    ],
    [
      "auto-loads bundled plugins referenced by configured provider ids",
      createStartupConfig({
        providerIds: ["demo-provider"],
      }),
      ["demo-channel", "demo-default-on-sidecar", "demo-provider-plugin", "demo-global-sidecar"],
    ],
  ] as const)("%s", (_name, config, expected) => {
    expectStartupPluginIdsCase({ config, expected });
  });
});

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
      },
      {
        id: "demo-other-channel",
        channels: ["demo-other-channel"],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
      },
      {
        id: "browser",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: [],
      },
      {
        id: "demo-provider-plugin",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: ["demo-provider"],
      },
      {
        id: "voice-call",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
      },
      {
        id: "demo-global-sidecar",
        channels: [],
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
      },
    ],
    diagnostics: [],
  };
}

function expectStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  expected: readonly string[];
}) {
  expect(
    resolveGatewayStartupPluginIds({
      config: params.config,
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      workspaceDir: "/tmp",
      env: process.env,
    }),
  ).toEqual(params.expected);
  expect(loadPluginManifestRegistry).toHaveBeenCalled();
}

function expectStartupPluginIdsCase(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  expected: readonly string[];
}) {
  expectStartupPluginIds(params);
}

function createStartupConfig(params: {
  enabledPluginIds?: string[];
  providerIds?: string[];
  modelId?: string;
  channelIds?: string[];
  allowPluginIds?: string[];
  noConfiguredChannels?: boolean;
}) {
  return {
    ...(params.noConfiguredChannels
      ? {
          channels: {},
        }
      : params.channelIds?.length
        ? {
            channels: Object.fromEntries(
              params.channelIds.map((channelId) => [channelId, { enabled: true }]),
            ),
          }
        : {}),
    ...(params.enabledPluginIds?.length
      ? {
          plugins: {
            ...(params.allowPluginIds?.length ? { allow: params.allowPluginIds } : {}),
            entries: Object.fromEntries(
              params.enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
            ),
          },
        }
      : params.allowPluginIds?.length
        ? {
            plugins: {
              allow: params.allowPluginIds,
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
    listPotentialConfiguredChannelIds.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {});
      }
      return ["demo-channel"];
    });
    loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistryFixture());
  });

  it.each([
    [
      "includes only configured channel plugins at idle startup",
      createStartupConfig({
        enabledPluginIds: ["voice-call"],
        modelId: "demo-cli/demo-model",
      }),
      ["demo-channel", "browser", "voice-call"],
    ],
    [
      "keeps bundled startup sidecars with enabledByDefault at idle startup",
      {} as OpenClawConfig,
      ["demo-channel", "browser"],
    ],
    [
      "keeps provider plugins out of idle startup when only provider config references them",
      createStartupConfig({
        providerIds: ["demo-provider"],
      }),
      ["demo-channel", "browser"],
    ],
    [
      "includes explicitly enabled non-channel sidecars in startup scope",
      createStartupConfig({
        enabledPluginIds: ["demo-global-sidecar", "voice-call"],
      }),
      ["demo-channel", "browser", "voice-call", "demo-global-sidecar"],
    ],
    [
      "keeps default-enabled startup sidecars when a restrictive allowlist permits them",
      createStartupConfig({
        allowPluginIds: ["browser"],
        noConfiguredChannels: true,
      }),
      ["browser"],
    ],
    [
      "includes every configured channel plugin and excludes other channels",
      createStartupConfig({
        channelIds: ["demo-channel", "demo-other-channel"],
      }),
      ["demo-channel", "demo-other-channel", "browser"],
    ],
  ] as const)("%s", (_name, config, expected) => {
    expectStartupPluginIdsCase({ config, expected });
  });

  it("keeps effective-only bundled sidecars behind restrictive allowlists", () => {
    const rawConfig = createStartupConfig({
      allowPluginIds: ["browser"],
    });
    const effectiveConfig = {
      ...rawConfig,
      plugins: {
        allow: ["browser"],
        entries: {
          "voice-call": {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    expectStartupPluginIdsCase({
      config: effectiveConfig,
      activationSourceConfig: rawConfig,
      expected: ["demo-channel", "browser"],
    });
  });
});

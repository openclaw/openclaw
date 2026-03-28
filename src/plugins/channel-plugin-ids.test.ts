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
}

function expectManifestRegistryFixture() {
  expect(loadPluginManifestRegistry).toHaveBeenCalled();
}

describe("resolveGatewayStartupPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockReturnValue(["demo-channel"]);
    loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistryFixture());
  });

  it.each([
    [
      "includes configured channels, explicit bundled sidecars, and enabled non-bundled sidecars",
      {
        plugins: {
          entries: {
            "demo-bundled-sidecar": { enabled: true },
          },
        },
        agents: {
          defaults: {
            model: { primary: "demo-cli/demo-model" },
            models: {
              "demo-cli/demo-model": {},
            },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "demo-provider-plugin", "demo-bundled-sidecar", "demo-global-sidecar"],
    ],
    [
      "does not pull default-on bundled non-channel plugins into startup",
      {} as OpenClawConfig,
      ["demo-channel", "demo-global-sidecar"],
    ],
    [
      "auto-loads bundled plugins referenced by configured provider ids",
      {
        models: {
          providers: {
            "demo-provider": {
              baseUrl: "https://example.com",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "demo-provider-plugin", "demo-global-sidecar"],
    ],
  ] as const)("%s", (_name, config, expected) => {
    expectStartupPluginIds(config, expected);
    expectManifestRegistryFixture();
  });
});

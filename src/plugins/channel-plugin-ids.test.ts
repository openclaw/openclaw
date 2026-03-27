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

describe("resolveGatewayStartupPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockReturnValue(["discord"]);
    loadPluginManifestRegistry.mockReset().mockReturnValue({
      plugins: [
        {
          id: "discord",
          channels: ["discord"],
          origin: "bundled",
          enabledByDefault: undefined,
          providers: [],
          cliBackends: [],
        },
        {
          id: "amazon-bedrock",
          channels: [],
          origin: "bundled",
          enabledByDefault: true,
          providers: [],
          cliBackends: [],
        },
        {
          id: "anthropic",
          channels: [],
          origin: "bundled",
          enabledByDefault: undefined,
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
        },
        {
          id: "diagnostics-otel",
          channels: [],
          origin: "bundled",
          enabledByDefault: undefined,
          providers: [],
          cliBackends: [],
        },
        {
          id: "custom-sidecar",
          channels: [],
          origin: "global",
          enabledByDefault: undefined,
          providers: [],
          cliBackends: [],
        },
      ],
      diagnostics: [],
    });
  });

  it("includes configured channels, explicit bundled sidecars, and enabled non-bundled sidecars", () => {
    const config = {
      plugins: {
        entries: {
          "diagnostics-otel": { enabled: true },
        },
      },
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-sonnet-4-6" },
          models: {
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGatewayStartupPluginIds({
        config,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["discord", "anthropic", "diagnostics-otel", "custom-sidecar"]);
  });

  it("does not pull default-on bundled non-channel plugins into startup", () => {
    const config = {} as OpenClawConfig;

    expect(
      resolveGatewayStartupPluginIds({
        config,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["discord", "custom-sidecar"]);
  });

  it("auto-loads bundled plugins referenced by configured provider ids", () => {
    const config = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://example.com",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGatewayStartupPluginIds({
        config,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["discord", "anthropic", "custom-sidecar"]);
  });
});

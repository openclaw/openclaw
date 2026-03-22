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
        },
        {
          id: "amazon-bedrock",
          channels: [],
          origin: "bundled",
          enabledByDefault: true,
        },
        {
          id: "diagnostics-otel",
          channels: [],
          origin: "bundled",
          enabledByDefault: undefined,
        },
        {
          id: "custom-sidecar",
          channels: [],
          origin: "global",
          enabledByDefault: undefined,
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
    } as OpenClawConfig;

    expect(
      resolveGatewayStartupPluginIds({
        config,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["discord", "diagnostics-otel", "custom-sidecar"]);
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
});

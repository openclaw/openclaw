import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearBundledPluginMetadataCache } from "../plugins/bundled-plugin-metadata.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";

const runChannelPluginStartupMaintenanceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: runChannelPluginStartupMaintenanceMock,
}));

import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup channel maintenance wiring", () => {
  it("runs startup channel maintenance with the resolved startup config", async () => {
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.resolve(process.cwd(), "extensions");
    process.env.OPENCLAW_SKIP_CHANNELS = "0";
    clearBundledPluginMetadataCache();
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
    runChannelPluginStartupMaintenanceMock.mockClear();

    testState.channelsConfig = {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
    };

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    try {
      server = await startGatewayServer(await getFreePort());

      expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledTimes(1);
      expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            channels: expect.objectContaining({
              matrix: expect.objectContaining({
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              }),
            }),
          }),
          env: process.env,
          log: expect.anything(),
        }),
      );
    } finally {
      await server?.close();
      if (previousBundledPluginsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
      }
      if (previousSkipChannels === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNELS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
      }
      clearBundledPluginMetadataCache();
      clearPluginDiscoveryCache();
      clearPluginManifestRegistryCache();
    }
  });
});

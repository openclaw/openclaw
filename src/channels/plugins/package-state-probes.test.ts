import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

const hoisted = vi.hoisted(() => ({
  listChannelCatalogEntries: vi.fn(),
  existsSync: vi.fn(() => false),
  loadChannelPluginModule: vi.fn(),
  resolveExistingPluginModulePath: vi.fn(),
}));

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: hoisted.listChannelCatalogEntries,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, default: { ...actual, existsSync: hoisted.existsSync } };
});

vi.mock("./module-loader.js", () => ({
  loadChannelPluginModule: hoisted.loadChannelPluginModule,
  resolveExistingPluginModulePath: hoisted.resolveExistingPluginModulePath,
}));

const listChannelCatalogEntriesMock = hoisted.listChannelCatalogEntries;

function makeBundledChannelCatalogEntry(params: {
  pluginId: string;
  channelId: string;
}): PluginChannelCatalogEntry {
  return {
    pluginId: params.pluginId,
    origin: "bundled",
    rootDir: "/tmp/openclaw-channel-plugin",
    channel: {
      id: params.channelId,
      configuredState: {
        env: {
          allOf: ["ALIAS_CHAT_TOKEN"],
        },
      },
    },
  };
}

beforeEach(() => {
  listChannelCatalogEntriesMock.mockReset();
  hoisted.existsSync.mockReset();
  hoisted.existsSync.mockReturnValue(false);
  hoisted.loadChannelPluginModule.mockReset();
  hoisted.resolveExistingPluginModulePath.mockReset();
});

describe("channel package-state probes", () => {
  it("uses channel ids when manifest plugin ids differ", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      makeBundledChannelCatalogEntry({
        pluginId: "vendor-alias-chat-plugin",
        channelId: "alias-chat",
      }),
    ]);

    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual(["alias-chat"]);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "alias-chat",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "vendor-alias-chat-plugin",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(false);
  });

  it("prefers built .js artifact over source .ts when dist path exists (dev-checkout source loading fix)", () => {
    const sourceTs = "/home/ubuntu/openclaw/extensions/matrix/auth-presence.ts";
    const builtJs = "/home/ubuntu/openclaw/dist/extensions/matrix/auth-presence.js";

    const checkerEntry: PluginChannelCatalogEntry = {
      pluginId: "matrix",
      origin: "bundled",
      rootDir: "/home/ubuntu/openclaw/extensions/matrix",
      channel: {
        id: "matrix",
        persistedAuthState: { specifier: "./auth-presence", exportName: "hasAnyMatrixAuth" },
      },
    };
    listChannelCatalogEntriesMock.mockReturnValue([checkerEntry]);

    // Simulate dev checkout: resolveExistingPluginModulePath finds the source .ts first
    hoisted.resolveExistingPluginModulePath.mockReturnValue(sourceTs);
    // existsSync: dist .js exists, source .ts does not (in the dist check path)
    hoisted.existsSync.mockImplementation((p: string) => p === builtJs);
    hoisted.loadChannelPluginModule.mockReturnValue({ hasAnyMatrixAuth: () => true });

    const result = hasBundledChannelPackageState({
      metadataKey: "persistedAuthState",
      channelId: "matrix",
      cfg: {},
    });

    expect(result).toBe(true);
    // The built .js path must have been passed to loadChannelPluginModule, not the source .ts
    expect(hoisted.loadChannelPluginModule).toHaveBeenCalledWith(
      expect.objectContaining({ modulePath: builtJs }),
    );
    expect(hoisted.loadChannelPluginModule).not.toHaveBeenCalledWith(
      expect.objectContaining({ modulePath: sourceTs }),
    );
  });
});

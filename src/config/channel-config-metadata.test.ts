import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return { plugins, diagnostics: [] };
}

function createPluginRecord(
  overrides: Pick<PluginManifestRecord, "id" | "origin"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    id: overrides.id,
    origin: overrides.origin,
    rootDir: `/tmp/${overrides.id}`,
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

describe("channel config metadata", () => {
  it("skips unreadable plugin schema rows without dropping healthy rows", () => {
    const unreadable = createPluginRecord({
      id: "broken-plugin",
      origin: "workspace",
    });
    Object.defineProperty(unreadable, "id", {
      get() {
        throw new Error("plugin schema metadata id exploded");
      },
    });

    expect(
      collectPluginSchemaMetadata(
        createRegistry([
          unreadable,
          createPluginRecord({
            id: "healthy-plugin",
            origin: "workspace",
            name: "Healthy plugin",
            description: "Healthy plugin config",
            configSchema: { type: "object" },
          }),
        ]),
      ),
    ).toStrictEqual([
      {
        id: "healthy-plugin",
        name: "Healthy plugin",
        description: "Healthy plugin config",
        configSchema: { type: "object" },
        configUiHints: undefined,
      },
    ]);
  });

  it("skips unreadable channel schema rows without dropping healthy rows", () => {
    const unreadable = createPluginRecord({
      id: "broken-channel-plugin",
      origin: "workspace",
    });
    Object.defineProperty(unreadable, "channels", {
      get() {
        throw new Error("channel schema metadata channels exploded");
      },
    });

    expect(
      collectChannelSchemaMetadata(
        createRegistry([
          unreadable,
          createPluginRecord({
            id: "healthy-channel-plugin",
            origin: "workspace",
            channels: ["healthy-chat"],
            channelCatalogMeta: {
              id: "healthy-chat",
              label: "Healthy Chat",
              blurb: "Healthy channel config",
            },
            channelConfigs: {
              "healthy-chat": {
                label: "Healthy Chat Config",
                description: "Healthy config schema",
                schema: { type: "object" },
              },
            },
          }),
        ]),
      ),
    ).toStrictEqual([
      {
        id: "healthy-chat",
        label: "Healthy Chat Config",
        description: "Healthy config schema",
        configSchema: { type: "object" },
        configUiHints: undefined,
      },
    ]);
  });
});

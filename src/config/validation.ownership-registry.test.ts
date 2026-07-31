import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

function pluginRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "global",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

describe("raw validation ownership warnings", () => {
  it("uses fallback plugin discovery for active custom channels", () => {
    const registry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        pluginRecord({
          id: "custom-owner",
          channels: ["customchat"],
          configSchema: { type: "object", additionalProperties: true },
          channelConfigs: {
            customchat: {
              schema: { type: "object", additionalProperties: true },
            },
          },
        }),
      ],
    };
    const loadPluginMetadataSnapshot = vi.fn(() => ({ manifestRegistry: registry }));

    const result = validateConfigObjectRawWithPlugins(
      {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
        channels: { customchat: { enabled: true } },
        plugins: {
          allow: ["custom-owner"],
          entries: { "custom-owner": { enabled: true } },
        },
      },
      { loadPluginMetadataSnapshot },
    );

    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalled();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        path: "channels.customchat",
        message: expect.stringContaining("has no channel-wide owner"),
      }),
    );
  });
});

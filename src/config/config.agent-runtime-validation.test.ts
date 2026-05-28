import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createPluginRecord(
  partial: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/fake/${partial.id}`,
    source: `/fake/${partial.id}/index.js`,
    manifestPath: `/fake/${partial.id}/openclaw.plugin.json`,
    ...partial,
  };
}

function createRegistry(plugins: PluginManifestRecord[]): PluginManifestRegistry {
  return { plugins, diagnostics: [] };
}

describe("agent runtime config validation", () => {
  it("rejects provider ids used as provider-scoped agent runtime ids", () => {
    const result = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              agentRuntime: { id: "anthropic" },
              models: [],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createRegistry([
            createPluginRecord({
              id: "anthropic",
              providers: ["anthropic"],
              cliBackends: ["claude-cli"],
            }),
          ]),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "models.providers.anthropic.agentRuntime.id",
        message:
          'unknown agent runtime "anthropic"; "anthropic" is a provider id, not an agent runtime. Use "claude-cli" for this plugin CLI runtime, or remove agentRuntime to use the provider through the default PI runtime.',
      });
    }
  });

  it("rejects unknown model-scoped agent runtime ids", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                agentRuntime: { id: "missing-runtime" },
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createRegistry([
            createPluginRecord({
              id: "anthropic",
              providers: ["anthropic"],
              cliBackends: ["claude-cli"],
            }),
          ]),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "agents.defaults.models.anthropic/claude-sonnet-4-6.agentRuntime.id",
        message:
          'unknown agent runtime "missing-runtime". Use a registered agent runtime id such as pi, or remove agentRuntime for automatic selection.',
      });
    }
  });
});

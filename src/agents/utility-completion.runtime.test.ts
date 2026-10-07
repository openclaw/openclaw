import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as modelAuth from "./model-auth.js";
import {
  resolveUtilityCompletionRuntimeForAgent,
  type UtilityCompletionRuntimeParams,
} from "./utility-completion.js";

function prepared(utilityModelEntry?: {
  agentRuntime: { id: string };
}): UtilityCompletionRuntimeParams {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.cliBackends.push({
    pluginId: "anthropic",
    source: "runtime",
    backend: {
      id: "claude-cli",
      modelProvider: "anthropic",
      config: { command: "claude" },
    },
  });
  return {
    cfg: {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            apiKey: "synthetic-key",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          utilityModel: "anthropic/claude-haiku-4-5",
          ...(utilityModelEntry
            ? { models: { "anthropic/claude-haiku-4-5": utilityModelEntry } }
            : {}),
        },
      },
    } as OpenClawConfig,
    agentId: "main",
    pluginRegistry,
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
          providerAuthAliases: { "claude-cli": "anthropic" },
        },
      ],
    }),
    preparedAuthStore: { version: 1, profiles: {} },
    preparedRuntimeAuthModes: { "claude-cli": "oauth" },
    snapshot: {
      entries: [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" }],
      routeVariants: [],
    },
  };
}

describe("resolveUtilityCompletionRuntimeForAgent", () => {
  it.each([
    {
      pin: { agentRuntime: { id: "claude-cli" } },
      expected: { id: "claude-cli", kind: "cli", label: "Claude CLI" },
    },
    { pin: undefined, expected: { id: "openclaw", kind: "api", label: "OpenClaw Default" } },
  ])("reports the selected $expected.kind owner", async ({ pin, expected }) => {
    await expect(resolveUtilityCompletionRuntimeForAgent(prepared(pin))).resolves.toEqual(expected);
  });

  it.each([true, false])(
    "reports a plugin harness only when it supports isolated completions (%s)",
    async (isolated) => {
      const params = prepared({ agentRuntime: { id: "route-test" } });
      params.pluginRegistry!.agentHarnesses.push({
        pluginId: "route-test",
        source: "runtime",
        harness: {
          id: "route-test",
          label: "Route Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          ...(isolated ? { runIsolatedCompletionV2: vi.fn() } : {}),
        },
      });
      await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toEqual(
        isolated ? { id: "route-test", kind: "harness", label: "Route Test" } : undefined,
      );
    },
  );

  it.each(["missing credentials", "retired owner"])("omits a route with %s", async (reason) => {
    const params = prepared();
    if (reason === "missing credentials") {
      params.cfg.models = undefined;
    } else {
      params.isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    }
    await withEnvAsync(
      { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined },
      async () => {
        await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toBeUndefined();
      },
    );
  });
});

describe("automatic utility runtime prepared-generation composition", () => {
  it.each([false, true])(
    "uses only prepared API credential availability (%s)",
    async (hasApiCredential) => {
      const params = prepared();
      params.cfg.models = undefined;
      params.cfg.agents!.defaults!.utilityModel = undefined;
      params.cfg.agents!.defaults!.models = {
        "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
      };
      const plugin = params.metadataSnapshot.plugins[0];
      if (!plugin) {
        throw new Error("Expected the Anthropic metadata fixture.");
      }
      plugin.modelCatalog = {
        providers: {
          anthropic: {
            defaultUtilityModel: "claude-haiku-4-5",
            models: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-4-6" }],
          },
        },
      };
      if (hasApiCredential) {
        params.preparedAuthStore.profiles["anthropic:test"] = {
          type: "api_key",
          provider: "anthropic",
          key: "synthetic-prepared-key",
        };
      }
      const credentialLookup = vi.spyOn(modelAuth, "hasAvailableAuthForProvider");
      try {
        const runtime = await resolveUtilityCompletionRuntimeForAgent(params);
        expect(runtime).toEqual(
          hasApiCredential
            ? { id: "openclaw", kind: "api", label: "OpenClaw Default" }
            : { id: "claude-cli", kind: "cli", label: "Claude CLI" },
        );
        expect(credentialLookup).not.toHaveBeenCalled();
      } finally {
        credentialLookup.mockRestore();
      }
    },
  );
});

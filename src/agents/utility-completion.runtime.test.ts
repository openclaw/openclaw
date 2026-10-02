import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withEnvAsync } from "../test-utils/env.js";
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
  it("reports the Claude CLI owner a utility model's runtime pin dispatches to", async () => {
    await expect(
      resolveUtilityCompletionRuntimeForAgent(prepared({ agentRuntime: { id: "claude-cli" } })),
    ).resolves.toEqual({ id: "claude-cli", kind: "cli", label: "Claude CLI" });
  });

  it("reports the built-in HTTP runtime for a utility model without a CLI route", async () => {
    await expect(resolveUtilityCompletionRuntimeForAgent(prepared())).resolves.toEqual({
      id: "openclaw",
      kind: "api",
      label: "OpenClaw Default",
    });
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

  it("omits the built-in API label when the prepared owner has no usable credentials", async () => {
    const params = prepared();
    params.cfg.models = undefined;
    await withEnvAsync(
      { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined },
      async () => {
        await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toBeUndefined();
      },
    );
  });

  it("omits a planned route when its owner retires during preparation", async () => {
    const params = prepared();
    params.isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

function configuredModel(name: string): ModelDefinitionConfig {
  return {
    id: "choice",
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

describe("terminal model catalog availability", () => {
  it("keeps ready, unavailable and unknown published facts distinct", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "terminal-catalog-facts-" },
      async (state) => {
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              model: { primary: "ready/choice" },
              modelPolicy: { allow: ["ready/choice", "waiting/choice", "unknown/choice"] },
            },
          },
          models: {
            mode: "replace",
            providers: {
              ready: {
                baseUrl: "https://ready.invalid/v1",
                api: "openai-completions",
                apiKey: "synthetic-ready-key",
                models: [configuredModel("Ready")],
              },
              waiting: {
                baseUrl: "https://waiting.invalid/v1",
                api: "openai-completions",
                auth: "api-key",
                models: [configuredModel("Waiting")],
              },
              unknown: {
                baseUrl: "https://unknown.invalid/v1",
                api: "openai-completions",
                models: [configuredModel("Unknown")],
              },
            },
          },
          plugins: { enabled: false },
        };
        const context = createModelsListTestContext({
          cfg: config,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          catalog: ["ready", "waiting", "unknown"].map((provider) =>
            providerCatalogEntry(provider, "choice"),
          ),
        });

        const { models } = await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { includeDetails: true },
        });

        expect(models.find((model) => model.provider === "ready")).toMatchObject({
          available: true,
        });
        expect(models.find((model) => model.provider === "waiting")).toMatchObject({
          available: false,
          unavailableReason: "auth-failed",
        });
        expect(models.find((model) => model.provider === "unknown")).not.toHaveProperty(
          "available",
        );
      },
    );
  });
});

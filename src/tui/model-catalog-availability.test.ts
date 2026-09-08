import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

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
                models: [{ id: "choice", name: "Ready" }],
              },
              waiting: {
                baseUrl: "https://waiting.invalid/v1",
                api: "openai-completions",
                auth: "api-key",
                models: [{ id: "choice", name: "Waiting" }],
              },
              unknown: {
                baseUrl: "https://unknown.invalid/v1",
                api: "openai-completions",
                models: [{ id: "choice", name: "Unknown" }],
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

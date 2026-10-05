import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { resolveModelWithRegistry } from "../../agents/embedded-agent-runner/model.registry-resolution.js";
import { resolveModelProviderAuthConfig } from "../../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listModels } from "./models-list-result.openai-routes.test-support.js";

it.each([
  { configuredId: "arcee-ai/trinity-large-thinking", aliasId: "trinity-large-thinking" },
  { configuredId: "trinity-large-thinking", aliasId: "arcee-ai/trinity-large-thinking" },
])(
  "joins authored metadata and alias across $configuredId / $aliasId",
  async ({ configuredId, aliasId }) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "arcee-public-catalog-" },
      async (state) => {
        const authored: ModelCatalogEntry = {
          provider: "arcee",
          id: "arcee-ai/trinity-large-thinking",
          name: "Authored default",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          contextWindow: 32768,
          reasoning: false,
        };
        const cfg: OpenClawConfig = {
          plugins: { allow: ["arcee"] },
          agents: {
            defaults: {
              model: { primary: "arcee/trinity-large-thinking" },
              models: { [`arcee/${aliasId}`]: { alias: "Work account model" } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              arcee: {
                baseUrl: "https://openrouter.ai/api/v1",
                api: "openai-completions",
                models: [
                  {
                    id: configuredId,
                    name: "Authored default",
                    contextWindow: 32768,
                    reasoning: false,
                    input: ["text"],
                    maxTokens: 2048,
                    cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
                  },
                ],
              },
            },
          },
        };
        await state.writeConfig(cfg);
        const result = await listModels({
          cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          view: "all",
          catalog: [
            authored,
            {
              ...authored,
              id: "trinity-large-thinking",
              name: "Static sibling",
              contextWindow: 262144,
              reasoning: true,
            },
          ],
        });
        expect(result.models).toHaveLength(1);
        expect(result.models[0]).toMatchObject({
          provider: "arcee",
          id: "trinity-large-thinking",
          name: "Authored default",
          contextWindow: 32768,
          reasoning: false,
          alias: "Work account model",
          tags: expect.arrayContaining(["default", "configured"]),
        });
      },
    );
  },
);

it("materializes a catalog selection from its authored provider wire row", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "arcee-picker-roundtrip-" },
    async (state) => {
      const row = {
        id: "arcee-ai/trinity-large-thinking",
        name: "Authored route",
        api: "openai-completions" as const,
        baseUrl: "https://api.arcee.ai/api/v1",
        headers: { "X-Authored-Row": "preserved" },
        reasoning: false,
        input: ["text" as const],
        contextWindow: 32768,
        maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const cfg: OpenClawConfig = {
        plugins: { allow: ["arcee"] },
        agents: { defaults: { model: { primary: "arcee/trinity-large-thinking" } } },
        models: {
          mode: "replace",
          providers: {
            arcee: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [row],
            },
          },
        },
      };
      await state.writeConfig(cfg);
      const listed = await listModels({
        cfg,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        view: "all",
        catalog: [{ ...row, provider: "arcee" }],
      });
      expect(listed.models).toHaveLength(1);
      const selected = listed.models[0];
      assert(selected);
      expect(selected).toMatchObject({
        provider: "arcee",
        id: "trinity-large-thinking",
        contextWindow: 32768,
      });
      const model = await resolveModelWithRegistry({
        cfg,
        provider: selected.provider,
        modelId: selected.id,
        agentDir: state.agentDir(),
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      });
      const authConfig = resolveModelProviderAuthConfig({
        config: cfg,
        provider: selected.provider,
        modelId: selected.id,
      });
      expect.soft(model).toMatchObject({
        name: row.name,
        baseUrl: row.baseUrl,
        headers: row.headers,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
      });
      expect.soft(authConfig.models?.providers?.arcee?.baseUrl).toBe(row.baseUrl);
    },
  );
});

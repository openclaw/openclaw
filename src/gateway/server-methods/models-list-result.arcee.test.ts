import assert from "node:assert/strict";
import { expect, it, onTestFinished } from "vitest";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../../agents/embedded-agent-runner/model.js";
import { resolveModelProviderAuthConfig } from "../../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listModels } from "./models-list-result.openai-routes.test-support.js";

const route = { api: "openai-completions" as const, baseUrl: "https://openrouter.ai/api/v1" };
const authoredRow: ModelDefinitionConfig = {
  id: "arcee-ai/trinity-large-thinking",
  name: "Authored default",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 2048,
  cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
};
async function listArcee(
  row: ModelDefinitionConfig,
  aliasId?: string,
  catalog: ModelCatalogEntry[] = [{ ...row, provider: "arcee" }],
) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "arcee-catalog-" });
  onTestFinished(() => state.cleanup());
  const cfg: OpenClawConfig = {
    plugins: { allow: ["arcee"] },
    agents: {
      defaults: {
        model: { primary: "arcee/trinity-large-thinking" },
        ...(aliasId ? { models: { [`arcee/${aliasId}`]: { alias: "Work account model" } } } : {}),
      },
    },
    models: {
      mode: "replace",
      providers: { arcee: { ...route, models: [row] } },
    },
  };
  await state.writeConfig(cfg);
  const result = await listModels({
    cfg,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    view: "all",
    catalog,
  });
  return { result, state, cfg };
}

it.each([
  { configuredId: "arcee-ai/trinity-large-thinking", aliasId: "trinity-large-thinking" },
  { configuredId: "trinity-large-thinking", aliasId: "arcee-ai/trinity-large-thinking" },
])(
  "joins authored metadata and alias across $configuredId / $aliasId",
  async ({ configuredId, aliasId }) => {
    const { id, name, contextWindow, reasoning } = authoredRow;
    const authored = { ...route, provider: "arcee", id, name, contextWindow, reasoning };
    const { result } = await listArcee({ ...authoredRow, id: configuredId }, aliasId, [
      authored,
      {
        ...authored,
        id: "trinity-large-thinking",
        name: "Static sibling",
        contextWindow: 262144,
        reasoning: true,
      },
    ]);
    expect(result.models).toMatchObject([
      {
        provider: "arcee",
        id: "trinity-large-thinking",
        name: "Authored default",
        contextWindow: 32768,
        reasoning: false,
        alias: "Work account model",
        tags: expect.arrayContaining(["default", "configured"]),
      },
    ]);
  },
);

it("materializes a catalog selection from its authored provider wire row", async () => {
  const row = {
    ...authoredRow,
    name: "Authored route",
    api: "openai-completions" as const,
    baseUrl: "https://api.arcee.ai/api/v1",
    headers: { "X-Authored-Row": "preserved" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const { result: listed, state, cfg } = await listArcee(row);
  expect(listed.models).toHaveLength(1);
  const selected = listed.models[0];
  assert(selected);
  expect(selected).toMatchObject({
    provider: "arcee",
    id: "trinity-large-thinking",
    contextWindow: 32768,
  });
  const { model } = await resolveModelAsync(
    selected.provider,
    selected.id,
    state.agentDir(),
    cfg,
    createEmptyAgentDiscoveryStores(),
  );
  const authConfig = resolveModelProviderAuthConfig({
    config: cfg,
    provider: selected.provider,
    modelId: selected.id,
  });
  const { name, baseUrl, headers, contextWindow, maxTokens } = row;
  expect.soft(model).toMatchObject({ name, baseUrl, headers, contextWindow, maxTokens });
  expect.soft(authConfig.models?.providers?.arcee?.baseUrl).toBe(baseUrl);
});

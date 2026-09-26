import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ModelsListResultSchema } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";

const decision: ModelCatalogEntry = {
  provider: "fixture",
  id: "typed",
  name: "Typed",
  inference: {
    chat: false,
    decision: {
      protocol: "fixture",
      input: ["text"],
      questions: { boolean: { probabilities: "boolean", abstention: true } },
    },
  },
};
const chat: ModelCatalogEntry = { provider: "fixture", id: "chat", name: "Chat" };
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["fixture"],
      contracts: { decisionProviders: ["fixture"] },
      modelCatalog: {
        providers: { fixture: { models: [{ id: "typed", inference: decision.inference }] } },
      },
      decisionModels: [
        { provider: "fixture", id: "not-in-selected-snapshot", name: "Must not leak" },
      ],
    },
  ],
});

it("projects task and compatibility rows only after normal visibility, auth and owner checks", async () => {
  const cfg = {
    agents: {
      defaults: { model: "fixture/chat", models: { "fixture/chat": {}, "fixture/typed": {} } },
    },
  };
  const snapshot = { entries: [chat, decision], routeVariants: [chat, decision] };
  let current = true;
  const projector = createGatewayAgentModelCatalogProjector({
    cfg,
    agentId: "main",
    snapshot,
    metadataSnapshot,
    preparedAuthStore: { version: 1, profiles: {} },
    isCurrent: () => current,
  });
  const loadGatewayModelCatalogSnapshot = vi.fn(() => {
    throw new Error("Discovery forbidden");
  });
  const source = {
    kind: "gateway" as const,
    context: {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    },
  };
  const request = (task?: "chat" | "decision" | "all", view: "all" | "configured" = "configured") =>
    buildModelsListResult({
      source,
      agentId: "main",
      params: { task, view, preparedOnly: true },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      catalogProjector: projector,
      preloadedOnly: true,
    });
  expect((await request()).models.map((row) => row.id)).toEqual(["chat"]);
  const typed = await request("decision");
  expect(typed.models).toHaveLength(1);
  expect(typed.models[0]).toMatchObject({
    id: "typed",
    inference: decision.inference,
    available: false,
  });
  expect(typed.models[0]).not.toHaveProperty("agentRuntime");
  expect(typed.models[0]).not.toHaveProperty("thinkingLevels");
  expect(typed.models[0]).not.toHaveProperty("supportsFastMode");
  expect(typed.decisionModels?.map((row) => row.id)).toEqual(["typed"]);
  expect(Check(ModelsListResultSchema, typed)).toBe(true);
  expect((await request("all")).models).toHaveLength(2);
  expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  current = false;
  await expect(request("decision")).rejects.toThrow("Model catalog changed");
});

it.each([true, false])(
  "keeps legacy inventory distinct from configured chat visibility without raw metadata fallback (acquired decision: %s)",
  async (acquiredDecision) => {
    const cfg = { agents: { defaults: { model: "fixture/chat", models: { "fixture/chat": {} } } } };
    const entries = acquiredDecision ? [chat, decision] : [chat];
    const snapshot = { entries, routeVariants: entries };
    const projector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId: "main",
      snapshot,
      metadataSnapshot,
      preparedAuthStore: { version: 1, profiles: {} },
    });
    const result = await buildModelsListResult({
      source: {
        kind: "gateway",
        context: {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: async () => {
            throw new Error("Discovery forbidden");
          },
          logGateway: { debug: vi.fn() },
        },
      },
      params: { task: "decision", view: "configured" },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      catalogProjector: projector,
    });
    expect(result.models).toEqual([]);
    expect(result.decisionModels?.map((row) => row.id) ?? []).toEqual(
      acquiredDecision ? ["typed"] : [],
    );
  },
);

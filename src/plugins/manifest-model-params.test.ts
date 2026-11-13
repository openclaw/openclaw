import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPluginSchemaMetadataCore } from "../config/channel-config-metadata.js";
import { buildConfigSchemaCore, lookupConfigSchema } from "../config/schema.js";
import { validateConfigObjectRawWithPlugins } from "../config/validation.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";

// Load the public manifest only; config validation must not activate provider runtime.
const rootDir = path.resolve("extensions/vllm");
const manifestRegistry = loadPluginManifestRegistryCore({
  installRecords: {},
  candidates: [
    { idHint: "vllm", rootDir, source: path.join(rootDir, "index.ts"), origin: "bundled" },
  ],
});
const model = (type: string) => ({
  modelParamsSchema: { type: "object", properties: { priorityScheduling: { type } } },
});
const priority = (value: unknown) => ({ "vllm/model": { params: { priorityScheduling: value } } });
const schemaFor = (registry = manifestRegistry) =>
  buildConfigSchemaCore({ plugins: collectPluginSchemaMetadataCore(registry) });
const priorityPath = (scope: string, provider = "vllm") =>
  `${scope}.models.${provider}/model.params.priorityScheduling`;
const scopes = ["agents.defaults", "agents.entries.main"] as const;
const schemaAt = (response: ReturnType<typeof schemaFor>, key: string) =>
  lookupConfigSchema(response, key)?.schema;
type Models = Record<string, { params: Record<string, unknown> }>;
const validate = (models: Models, agentModels?: Models, registry = manifestRegistry) =>
  validateConfigObjectRawWithPlugins(
    {
      agents: {
        defaults: { models },
        ...(agentModels && { entries: { main: { models: agentModels } } }),
      },
    },
    { pluginMetadataSnapshot: { manifestRegistry: registry } },
  );

describe("provider-owned model params", () => {
  it("rejects invalid vLLM model options in default and per-agent scopes", () => {
    const result = validate(priority("true"), priority(1));
    expect(result).toMatchObject({
      ok: false,
      issues: scopes.map((scope) => ({
        path: priorityPath(scope),
        message: "invalid model params: must be boolean",
      })),
    });
  });

  it("preserves omitted settings, ordinary params, and other provider namespaces", () => {
    const models = {
      "vllm/model": { params: { temperature: 0.3, priority: 0 } },
      "vllm/interactive": { params: { priorityScheduling: true } },
      "other/model": { params: { priorityScheduling: "other-provider-contract" } },
    };
    const agentModels = { "vllm/interactive": { params: { temperature: 0.5 } } };
    const result = validate(models, agentModels);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([
        result.config.agents?.defaults?.models,
        result.config.agents?.entries?.main?.models,
      ]).toEqual([models, agentModels]);
    }
  });

  it("exposes the model schema and server prerequisite only for vLLM model paths", () => {
    const registry = {
      ...manifestRegistry,
      plugins: manifestRegistry.plugins.flatMap((plugin) => [
        { ...plugin, id: "z-first", providerRequest: { providers: { vllm: model("string") } } },
        { ...plugin, id: "a-last" },
      ]),
    };
    const response = schemaFor(registry);
    expect(validate(priority(true), undefined, registry).ok).toBe(true);
    for (const scope of scopes) {
      expect(schemaAt(response, priorityPath(scope))).toMatchObject({
        type: "boolean",
        title: "Priority scheduling",
        description: expect.stringContaining("--scheduling-policy priority"),
      });
      const unrelated = schemaAt(response, priorityPath(scope, "other"));
      expect([unrelated?.type, unrelated?.description]).toEqual([undefined, undefined]);
      expect(schemaAt(response, `${scope}.models.vllm/model.alias`)?.type).toBe("string");
    }
  });

  it("budgets both default and per-agent copies of provider model schemas", () => {
    const providers = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `demo${index}`,
        { modelParamsSchema: { type: "object", description: "x".repeat(220 * 1024) } },
      ]),
    );
    const response = buildConfigSchemaCore({
      plugins: [{ id: "budget", providerRequest: { providers } }],
    });
    for (const scope of scopes) {
      const description = (index: number) =>
        schemaAt(response, `${scope}.models.demo${index}/model.params`)?.description;
      expect(description(3)).toHaveLength(220 * 1024);
      expect(description(4)).toContain("exceeded the Gateway response budget");
    }
  });
});

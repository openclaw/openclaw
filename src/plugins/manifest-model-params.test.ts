import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPluginSchemaMetadataCore } from "../config/channel-config-metadata.js";
import { buildConfigSchemaCore, lookupConfigSchema } from "../config/schema.js";
import { validateConfigObjectRawWithPlugins } from "../config/validation.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { buildPluginMetadataProviderFacts } from "./plugin-metadata-provider-facts.js";

// Load the public manifest only; config validation must not activate provider runtime.
const rootDir = path.resolve("extensions/vllm");
const manifestRegistry = loadPluginManifestRegistryCore({
  installRecords: {},
  candidates: [
    { idHint: "vllm", rootDir, source: path.join(rootDir, "index.ts"), origin: "bundled" },
  ],
});
const metadata = { pluginMetadataSnapshot: { manifestRegistry } };

describe("provider-owned model params", () => {
  it("rejects invalid vLLM model options in default and per-agent scopes", () => {
    const result = validateConfigObjectRawWithPlugins(
      {
        agents: {
          defaults: { models: { "vllm/model": { params: { priorityScheduling: "true" } } } },
          entries: {
            main: { models: { "vllm/model": { params: { priorityScheduling: 1 } } } },
          },
        },
      },
      metadata,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "agents.defaults.models.vllm/model.params.priorityScheduling",
          message: "invalid model params: must be boolean",
        }),
        expect.objectContaining({
          path: "agents.entries.main.models.vllm/model.params.priorityScheduling",
          message: "invalid model params: must be boolean",
        }),
      ]);
    }
  });

  it("preserves omitted settings, ordinary params, and other provider namespaces", () => {
    const models = {
      "vllm/model": { params: { temperature: 0.3, priority: 0 } },
      "vllm/interactive": { params: { priorityScheduling: true } },
      "other/model": { params: { priorityScheduling: "other-provider-contract" } },
    };
    const result = validateConfigObjectRawWithPlugins(
      {
        agents: {
          defaults: { models },
          entries: { main: { models: { "vllm/interactive": { params: { temperature: 0.5 } } } } },
        },
      },
      metadata,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.agents?.defaults?.models).toEqual(models);
      expect(result.config.agents?.entries?.main?.models).toEqual({
        "vllm/interactive": { params: { temperature: 0.5 } },
      });
    }
  });

  it("exposes the model schema and server prerequisite only for vLLM model paths", () => {
    const response = buildConfigSchemaCore({
      plugins: collectPluginSchemaMetadataCore(manifestRegistry),
    });
    for (const scope of ["agents.defaults", "agents.entries.main"]) {
      expect(
        lookupConfigSchema(response, `${scope}.models.vllm/model.params.priorityScheduling`),
      ).toMatchObject({
        schema: {
          type: "boolean",
          title: "Priority scheduling",
          description: expect.stringContaining("--scheduling-policy priority"),
        },
      });
      const unrelated = lookupConfigSchema(
        response,
        `${scope}.models.other/model.params.priorityScheduling`,
      );
      expect(unrelated?.schema.type).toBeUndefined();
      expect(unrelated?.schema.description).toBeUndefined();
      expect(lookupConfigSchema(response, `${scope}.models.vllm/model.alias`)?.schema.type).toBe(
        "string",
      );
    }
  });

  it("uses the request metadata owner for validation and schema presentation", () => {
    const registry = {
      ...manifestRegistry,
      plugins: manifestRegistry.plugins.flatMap((plugin) => [
        {
          ...plugin,
          id: "z-first",
          providerRequest: {
            providers: {
              vllm: {
                modelParamsSchema: {
                  type: "object",
                  properties: { priorityScheduling: { type: "string" } },
                },
              },
            },
          },
        },
        { ...plugin, id: "a-last" },
      ]),
    };
    const result = validateConfigObjectRawWithPlugins(
      {
        agents: {
          defaults: { models: { "vllm/model": { params: { priorityScheduling: true } } } },
        },
      },
      { pluginMetadataSnapshot: { manifestRegistry: registry } },
    );
    expect(result.ok).toBe(true);
    const response = buildConfigSchemaCore({ plugins: collectPluginSchemaMetadataCore(registry) });
    expect(
      lookupConfigSchema(response, "agents.defaults.models.vllm/model.params.priorityScheduling")
        ?.schema.type,
    ).toBe("boolean");
    expect(
      buildPluginMetadataProviderFacts(registry.plugins).providerRequests.get("vllm"),
    ).toMatchObject({
      modelParamsSchema: { properties: { priorityScheduling: { type: "boolean" } } },
    });
  });

  it("budgets both default and per-agent copies of provider model schemas", () => {
    const response = buildConfigSchemaCore({
      plugins: [
        {
          id: "budget",
          providerRequest: {
            providers: Object.fromEntries(
              Array.from({ length: 5 }, (_, index) => [
                `demo${index}`,
                { modelParamsSchema: { type: "object", description: "x".repeat(220 * 1024) } },
              ]),
            ),
          },
        },
      ],
    });
    for (const scope of ["agents.defaults", "agents.entries.main"]) {
      expect(
        lookupConfigSchema(response, `${scope}.models.demo3/model.params`)?.schema.description,
      ).toHaveLength(220 * 1024);
      expect(
        lookupConfigSchema(response, `${scope}.models.demo4/model.params`)?.schema.description,
      ).toContain("exceeded the Gateway response budget");
    }
  });
});

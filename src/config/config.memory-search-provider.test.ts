import { describe, expect, it, vi } from "vitest";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugins/manifest-registry.js", () => {
  const providers = [
    ["acme-embed", "acme-embed"],
    ["gemini", "google"],
  ] as const;
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  return {
    loadPluginManifestRegistryCore: () => ({
      plugins: providers.map(([id, pluginId]) => ({
        id: pluginId,
        origin: "bundled",
        channels: [],
        providers: [],
        contracts: { embeddingProviders: [id] },
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/tmp/plugins/${pluginId}`,
        source: "test",
        manifestPath: `/tmp/plugins/${pluginId}/openclaw.plugin.json`,
        schemaCacheKey: `test:${pluginId}`,
        configSchema,
      })),
      diagnostics: [],
    }),
    resolveManifestContractPluginIds: () => [],
    resolveManifestContractOwnerPluginId: () => undefined,
  };
});

const manifestRegistry = loadPluginManifestRegistryCore();

const validateStrict = (raw: unknown) =>
  validateConfigObjectRawWithPlugins(raw, {
    semanticValidation: "strict",
    pluginMetadataSnapshot: { manifestRegistry },
  });

describe("memory embedding provider config", () => {
  it("normalizes the provider casing at the config boundary", () => {
    const res = validateStrict({ memory: { search: { provider: "None" } } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.memory?.search?.provider).toBe("none");
    }
  });

  it("normalizes the fallback casing at the config boundary", () => {
    const res = validateStrict({ memory: { search: { provider: "none", fallback: "GEMINI" } } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.memory?.search?.fallback).toBe("gemini");
    }
  });

  it("keeps the FTS-only sentinel valid with an empty model", () => {
    const res = validateStrict({ memory: { search: { provider: "none", model: "" } } });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("accepts a registered plugin embedding provider id", () => {
    expect(validateStrict({ memory: { search: { provider: "gemini" } } }).ok).toBe(true);
  });

  it("accepts the core openai-compatible embedding provider id", () => {
    expect(validateStrict({ memory: { search: { provider: "openai-compatible" } } }).ok).toBe(true);
  });

  it("rejects an unregistered embedding provider id", () => {
    const res = validateStrict({ memory: { search: { provider: "not-a-provider" } } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: "memory.search.provider",
          message: "unknown memory embedding provider: not-a-provider",
          allowedValues: expect.arrayContaining(["auto", "gemini", "none", "openai-compatible"]),
        }),
      );
    }
  });

  it("rejects an unregistered per-agent embedding provider id", () => {
    const res = validateStrict({
      agents: {
        ownership: "explicit",
        entries: {
          ops: { memory: { search: { provider: "not-a-provider" } } },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: "agents.entries.ops.memory.search.provider",
          message: "unknown memory embedding provider: not-a-provider",
        }),
      );
    }
  });

  it("rejects the auto sentinel in the fallback slot", () => {
    const res = validateStrict({ memory: { search: { provider: "none", fallback: "auto" } } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: "memory.search.fallback",
          message: "unknown memory embedding provider: auto",
        }),
      );
    }
  });

  it("warns instead of blocking on a blank embedding model", () => {
    const res = validateStrict({ memory: { search: { provider: "none", model: "   " } } });
    expect(res.ok).toBe(true);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({
        path: "memory.search.model",
        message: "memory embedding model is blank and will be treated as unset",
      }),
    );
  });

  it("does not validate the embedding provider outside strict validation", () => {
    const res = validateConfigObjectRawWithPlugins(
      { memory: { search: { provider: "not-a-provider" } } },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );
    expect(res.ok).toBe(true);
  });

  it("keeps the memory provider string-typed in the base config schema", () => {
    const schema = computeBaseConfigSchemaResponse().schema as {
      properties?: {
        memory?: { properties?: { search?: { properties?: { provider?: { type?: string } } } } };
      };
    };
    expect(schema.properties?.memory?.properties?.search?.properties?.provider?.type).toBe(
      "string",
    );
  });
});

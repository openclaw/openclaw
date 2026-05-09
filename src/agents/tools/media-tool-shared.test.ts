import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasGenerationToolAvailability,
  resolveMediaToolLocalRoots,
  resolveModelFromRegistry,
  resolveModelFromRegistryOrConfig,
} from "./media-tool-shared.js";

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

function createModelRegistryStub(resolve: (provider: string, modelId: string) => unknown): {
  calls: Array<[string, string]>;
  registry: { find: (provider: string, modelId: string) => unknown };
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    registry: {
      find(provider, modelId) {
        calls.push([provider, modelId]);
        return resolve(provider, modelId);
      },
    },
  };
}

describe("resolveMediaToolLocalRoots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not widen default local roots from media sources", () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = resolveMediaToolLocalRoots(path.join(stateDir, "workspace-agent"), undefined, [
      path.join(picturesDir, "photo.png"),
      pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
      "/top-level-file.png",
    ]);

    const normalizedRoots = roots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath(moviesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });
});

describe("resolveModelFromRegistry", () => {
  it("normalizes provider and model refs before registry lookup", () => {
    const foundModel = { provider: "ollama", id: "qwen3.5:397b-cloud" };
    const { calls, registry } = createModelRegistryStub(() => foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: registry,
      provider: " OLLAMA ",
      modelId: " qwen3.5:397b-cloud ",
    });

    expect(calls).toEqual([["ollama", "qwen3.5:397b-cloud"]]);
    expect(result).toBe(foundModel);
  });

  it("reports the normalized ref when the registry lookup misses", () => {
    const { registry } = createModelRegistryStub(() => null);

    expect(() =>
      resolveModelFromRegistry({
        modelRegistry: registry,
        provider: " OLLAMA ",
        modelId: " qwen3.5:397b-cloud ",
      }),
    ).toThrow("Unknown model: ollama/qwen3.5:397b-cloud");
  });

  it("falls back to provider-prefixed custom model IDs", () => {
    const foundModel = { provider: "kimchi", id: "kimchi/claude-opus-4-6" };
    const { calls, registry } = createModelRegistryStub((_, modelId) =>
      modelId === "kimchi/claude-opus-4-6" ? foundModel : null,
    );

    const result = resolveModelFromRegistry({
      modelRegistry: registry,
      provider: "kimchi",
      modelId: "claude-opus-4-6",
    });

    expect(calls).toEqual([
      ["kimchi", "claude-opus-4-6"],
      ["kimchi", "kimchi/claude-opus-4-6"],
    ]);
    expect(result).toBe(foundModel);
  }, 180_000);
});

describe("resolveModelFromRegistryOrConfig", () => {
  it("falls back to config-defined provider models after registry lookup misses", () => {
    const { calls, registry } = createModelRegistryStub(() => null);
    const cfg = {
      models: {
        providers: {
          "local-openai": {
            baseUrl: "http://127.0.0.1:8317/v1",
            api: "openai-responses",
            authHeader: true,
            models: [
              {
                id: "gpt-5.4-mini",
                name: "GPT-5.4 Mini (Local PDF Route)",
                api: "openai-responses",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow: 272000,
                maxTokens: 128000,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModelFromRegistryOrConfig({
      modelRegistry: registry,
      provider: " local-openai ",
      modelId: " gpt-5.4-mini ",
      cfg,
    });

    expect(calls).toEqual([
      ["local-openai", "gpt-5.4-mini"],
      ["local-openai", "local-openai/gpt-5.4-mini"],
    ]);
    expect(result).toMatchObject({
      provider: "local-openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      input: ["text", "image"],
    });
  });

  it("matches config-defined providers by normalized provider id and scoped model id", () => {
    const { calls, registry } = createModelRegistryStub(() => null);
    const cfg = {
      models: {
        providers: {
          "aws-bedrock": {
            baseUrl: "https://bedrock-runtime.example.test",
            api: "openai-responses",
            authHeader: true,
            models: [
              {
                id: "aws-bedrock/claude-custom",
                name: "Claude Custom",
                api: "openai-responses",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveModelFromRegistryOrConfig({
      modelRegistry: registry,
      provider: "amazon-bedrock",
      modelId: "claude-custom",
      cfg,
    });

    expect(calls).toEqual([
      ["amazon-bedrock", "claude-custom"],
      ["amazon-bedrock", "amazon-bedrock/claude-custom"],
    ]);
    expect(result).toMatchObject({
      provider: "aws-bedrock",
      id: "aws-bedrock/claude-custom",
    });
  });
});

describe("hasGenerationToolAvailability", () => {
  it("allows generation tools for runtime providers configured without auth", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("omits generation tools when runtime providers are not configured", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => false,
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps explicit model config sufficient for generation tool registration", () => {
    const loadProviders = vi.fn(() => []);

    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        modelConfig: { primary: "local-image/workflow" },
        providers: loadProviders,
      }),
    ).toBe(true);
    expect(loadProviders).not.toHaveBeenCalled();
  });

  it("checks configured runtime providers against the supplied auth store", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        authStore: {
          version: 1,
          profiles: {
            "local-image:default": {
              provider: "local-image",
              type: "api_key",
              key: "test",
            },
          },
        },
        providers: [{ id: "local-image", defaultModel: "workflow" }],
      }),
    ).toBe(true);
  });
});

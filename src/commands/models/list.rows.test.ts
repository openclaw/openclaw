// Model list row tests cover rendered row construction for model listing output.
import { describe, expect, it, vi } from "vitest";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  shouldSuppressBuiltInModel: vi.fn(() => {
    throw new Error("runtime model suppression should be skipped");
  }),
  shouldSuppressBuiltInModelFromManifest: vi.fn(() => false),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: mocks.shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest: mocks.shouldSuppressBuiltInModelFromManifest,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

import { appendConfiguredProviderRows, appendProviderCatalogRows } from "./list.rows.js";

const authIndex = {
  hasProviderAuth: (provider: string) => provider === "codex",
  allowsProviderAuthAvailabilityFallback: () => false,
};

function requireOnlyRow(rows: ModelRow[]): ModelRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error("expected one model row");
  }
  return row;
}

describe("appendProviderCatalogRows", () => {
  it("can skip runtime model-suppression hooks for provider-catalog fast paths", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "codex",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "codex", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(mocks.shouldSuppressBuiltInModelFromManifest).toHaveBeenCalledWith({
      provider: "codex",
      id: "gpt-5.5",
      baseUrl: "https://chatgpt.com/backend-api",
      config: {
        agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
        models: { providers: {} },
      },
    });
    expect(mocks.normalizeProviderResolvedModelWithPlugin).not.toHaveBeenCalled();
    const row = requireOnlyRow(rows);
    expect(row.key).toBe("codex/gpt-5.5");
    expect(row.available).toBe(true);
    expect(row.missing).toBe(false);
  });

  it("applies manifest suppression when runtime model-suppression hooks are skipped", async () => {
    mocks.shouldSuppressBuiltInModelFromManifest.mockReturnValueOnce(true);
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: () => false,
          allowsProviderAuthAvailabilityFallback: () => false,
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(mocks.shouldSuppressBuiltInModelFromManifest).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      baseUrl: "https://api.openai.com/v1",
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        models: { providers: {} },
      },
    });
    expect(rows).toStrictEqual([]);
  });

  it("uses Codex auth availability for configured canonical OpenAI rows", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: (provider: string) => provider === "openai",
          allowsProviderAuthAvailabilityFallback: (provider: string) => provider === "openai",
        },
        configuredByKey: new Map([
          [
            "openai/gpt-5.5",
            {
              key: "openai/gpt-5.5",
              ref: { provider: "openai", model: "gpt-5.5" },
              tags: new Set(["configured"]),
              aliases: [],
            },
          ],
        ]),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    const row = requireOnlyRow(rows);
    expect(row.key).toBe("openai/gpt-5.5");
    expect(row.available).toBe(true);
    expect(row.tags).toEqual(["configured"]);
  });

  it("filters out providers not in models.providers when mode is replace", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
        {
          id: "grok-4",
          name: "grok-4",
          provider: "xai",
          api: "xai-responses",
          baseUrl: "https://api.xai.com/v1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              xai: {},
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: () => true,
          allowsProviderAuthAvailabilityFallback: () => false,
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("xai/grok-4");
  });

  it("does not filter out providers when mode is replace but browse is true", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
        {
          id: "grok-4",
          name: "grok-4",
          provider: "xai",
          api: "xai-responses",
          baseUrl: "https://api.xai.com/v1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              xai: {},
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          hasProviderAuth: () => true,
          allowsProviderAuthAvailabilityFallback: () => false,
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { local: false },
        browse: true,
        skipRuntimeModelSuppression: true,
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("openai/gpt-5.5");
    expect(rows[1].key).toBe("xai/grok-4");
  });
});

describe("appendConfiguredProviderRows", () => {
  it("keeps provider normalization for configured provider models", async () => {
    mocks.normalizeProviderResolvedModelWithPlugin.mockReturnValueOnce({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 200_000,
    } as never);
    const rows: ModelRow[] = [];

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          models: {
            providers: {
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                models: [
                  {
                    id: "claude-sonnet-4-6",
                    name: "Claude Sonnet 4.6",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "anthropic", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
    expect(requireOnlyRow(rows).input).toBe("text+image");
  });
});

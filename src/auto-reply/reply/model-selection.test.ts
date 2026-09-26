// Tests model selection resolution from directives, config, and session state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import {
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { isThinkingLevelSupported } from "../thinking.js";
import { prepareModelSelectionRuntime } from "./model-runtime-normalization.js";
import {
  createInitialState,
  makeConfiguredModel,
  makeEntry,
} from "./model-selection.inputs.test-support.js";
import { createModelSelectionState, resolveContextTokens } from "./model-selection.js";

type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
  { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
]);

const sessionPersistenceMocks = vi.hoisted(() => ({
  persistReplySessionEntry: vi.fn<PersistReplySessionEntry>(),
}));

const catalogRuntimeMocks = vi.hoisted(() => {
  const loadModelCatalog = vi.fn(
    async (_params?: unknown): Promise<unknown[]> => DEFAULT_MOCK_CATALOG_ENTRIES,
  );
  return {
    loadModelCatalog,
    // Delegate to the entries mock so per-test `loadModelCatalog.mockResolvedValueOnce`
    // still drives selection; tests that need a degraded snapshot override this directly.
    loadModelCatalogSnapshot: vi.fn(async (params?: unknown) => {
      const entries = await loadModelCatalog(params as never);
      return { entries, routeVariants: entries, authoritative: true };
    }),
  };
});

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: catalogRuntimeMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogRuntimeMocks.loadModelCatalogSnapshot,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: sessionPersistenceMocks.persistReplySessionEntry,
}));

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn(() => store);
  return {
    get store() {
      return store;
    },
    set store(next) {
      store = next;
    },
    ensureAuthProfileStore,
    reset() {
      store = { version: 1, profiles: {} };
      ensureAuthProfileStore.mockClear();
    },
  };
});

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: authProfileStoreMock.ensureAuthProfileStore,
}));

// Alias-aware stub: mirrors the real isStoredCredentialCompatibleWithAuthProvider
// but inlines the claude-cli->anthropic alias so tests don't need live plugin metadata.
vi.mock("../../agents/auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const resolveAuthKey = (v: string) => {
      const n = normalize(v);
      // claude-cli is a deprecated choice id that resolves to the anthropic auth key
      if (n === "claudecli") {
        return "anthropic";
      }
      return n;
    };
    const providerKey = resolveAuthKey(provider);
    const credentialKey = resolveAuthKey(credential.provider);
    if (credentialKey === providerKey) {
      return true;
    }
    // OpenAI Codex compat: openai api_key credential works for openai-codex provider
    if (providerKey === "openaiapicodex" || providerKey === "openaicodex") {
      return credentialKey === "openai" && credential.type === "api_key";
    }
    return false;
  },
}));

afterEach(() => {
  getContextWindowCaches().discoveredTokenCache.clear();
  sessionPersistenceMocks.persistReplySessionEntry.mockReset();
  authProfileStoreMock.reset();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
});

describe("createModelSelectionState catalog loading", () => {
  it.each([false, true])(
    "retains automatic-primary reasoning from prepared=%s metadata outside manual policy",
    async (prepared) => {
      const automatic = {
        provider: "fixture",
        id: "automatic",
        name: "Automatic",
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture/automatic",
            modelPolicy: { allow: ["fixture/manual"] },
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: "manual", name: "Manual", reasoning: false })],
            },
          },
        },
      };
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([automatic]);
      const state = await createInitialState(
        cfg,
        "fixture",
        "automatic",
        prepared
          ? { preparedModelCatalog: { entries: [automatic], routeVariants: [] } }
          : undefined,
      );
      expect(state.modelPolicy.allows({ provider: "fixture", model: "automatic" })).toBe(false);
      expect(
        isThinkingLevelSupported({
          provider: "fixture",
          model: "automatic",
          level: "xhigh",
          catalog: await state.resolveThinkingCatalog(),
        }),
      ).toBe(true);
      await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    },
  );

  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4");

    expect(state.allowedModelKeys.has("openai/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it.each([
    { reasoning: undefined, agentRuntime: undefined },
    { reasoning: false, agentRuntime: "codex" },
  ])(
    "hydrates thinking for its runtime (reasoning=$reasoning, runtime=$agentRuntime)",
    async ({ reasoning, agentRuntime }) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      ]);
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeConfiguredModel({ reasoning: undefined })],
            },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, "openai", "gpt-5.4", {
        preparedModelCatalog: agentRuntime
          ? {
              entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning }],
              routeVariants: [],
            }
          : undefined,
      });

      if (agentRuntime) {
        await state.resolveThinkingCatalog({
          provider: "openai",
          model: "gpt-5.4",
          agentRuntime: "openclaw",
        });
      }
      await expect(
        state.resolveDefaultThinkingLevel({ provider: "openai", model: "gpt-5.4", agentRuntime }),
      ).resolves.toBe("medium");
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
        config: cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: agentRuntime ?? "openclaw",
        effectiveRoute: { api: undefined, baseUrl: "https://api.openai.com/v1" },
      });
    },
  );

  it("reloads embedded thinking metadata when clearing a native runtime pin", async () => {
    const embedded = {
      provider: "openai",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
    };
    const sessionEntry = { agentRuntimeOverride: "codex" };
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([embedded]);

    const prepared = await prepareModelSelectionRuntime({
      cfg: {
        agents: {
          defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } },
        },
      },
      agentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      rawRuntime: "default",
      sessionEntry,
      catalog: [{ ...embedded, nativeRuntime: "codex", reasoning: true }],
    });

    expect(prepared).toMatchObject({ status: "ready", runtime: { kind: "clear" } });
    if (prepared.status !== "ready") {
      throw new Error(prepared.message);
    }
    expect(prepared.catalog).toEqual([embedded]);
    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "main", agentRuntime: "openclaw" }),
    );
  });

  it.each([
    ["fixture-primary", 872_000],
    ["fixture-secondary", 922_000],
  ] as const)(
    "uses prepared prompt budgets without an authored %s provider row",
    async (provider, expected) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
      const entries = [
        {
          provider: "fixture-secondary",
          id: "shared-model",
          name: "Shared model",
          reasoning: false,
          contextWindow: 1_050_000,
          contextTokens: 922_000,
        },
        {
          provider: "fixture-primary",
          id: "shared-model",
          name: "Shared model",
          reasoning: false,
          contextWindow: 1_000_000,
          contextTokens: 872_000,
        },
      ];
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { [`${provider}/shared-model`]: {} } } },
      };
      const state = await createInitialState(cfg, provider, "shared-model", {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextTokens: state.modelContextTokens,
          modelContextWindow: state.modelContextWindow,
        }),
      ).toBe(expected);
      // Thinking metadata retains automatic candidates outside the manual selection policy.
      expect(await state.resolveThinkingCatalog()).toEqual(entries);
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["m", 1_000_000, false],
    ["fixture/m", 64_000, false],
    ["m", 1_000_000, true],
    ["fixture/m", 64_000, true],
  ] as const)(
    "preserves literal catalog identity for %s (%i tokens, reversed=%s)",
    async (model, expectedContextWindow, reversed) => {
      // Both literal rows must survive regardless of their shared display key or order.
      const models = [
        makeConfiguredModel({ id: "m", contextWindow: 1_000_000 }),
        makeConfiguredModel({ id: "fixture/m", contextWindow: 64_000 }),
      ];
      if (reversed) {
        models.reverse();
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { modelPolicy: { allow: [] } } },
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://models.example/v1",
              models,
            },
          },
        },
      };
      const entries = [{ provider: "unrelated", id: "other", name: "Other" }];
      const state = await createInitialState(cfg, "fixture", model, {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });

      expect(state.modelContextWindow).toBe(expectedContextWindow);
      expect(state.allowedModelCatalog).toEqual([
        ...models.map(({ id, contextWindow }) =>
          expect.objectContaining({ provider: "fixture", id, contextWindow }),
        ),
        entries[0],
      ]);
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextWindow: state.modelContextWindow,
          modelContextTokens: state.modelContextTokens,
        }),
      ).toBe(expectedContextWindow);
    },
  );

  it("uses the prepared gateway owner catalog without an exact-generation reload", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel({ reasoning: undefined })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4", {
      preparedModelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
        routeVariants: [],
        authoritative: true,
      },
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { hasModelDirective: false, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: true, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium" },
    { hasModelDirective: true, capturedPolicy: false, expected: "medium" },
    { hasModelDirective: false, capturedPolicy: true, expected: "ultra", unrestricted: true },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium", unrestricted: true },
  ])(
    "keeps prepared thinking ownership through reply selection (directive=$hasModelDirective policy=$capturedPolicy unrestricted=$unrestricted)",
    async ({ hasModelDirective, capturedPolicy, expected, unrestricted }) => {
      const provider = "fixture-provider";
      const model = "fixture-model";
      const cfg: OpenClawConfig = {
        agents: unrestricted
          ? undefined
          : { defaults: { models: { [`${provider}/${model}`]: { alias: "Fixture" } } } },
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: model })],
            },
          },
        },
      };
      const preparedModelCatalog: ModelCatalogSnapshot = {
        entries: [{ provider, id: model, name: "Fixture", reasoning: true }],
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog: preparedModelCatalog,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        providers: [
          {
            provider: {
              id: provider,
              ...(capturedPolicy
                ? {
                    resolveThinkingProfile: () => ({
                      levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
                      defaultLevel: "ultra",
                    }),
                  }
                : {}),
            },
          },
        ],
      });
      const ambient = vi
        .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
        .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
      try {
        const state = await createInitialState(cfg, provider, model, {
          hasModelDirective,
          preparedModelCatalog,
        });
        await expect(
          state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
        ).resolves.toBe(expected);
        expect(ambient).not.toHaveBeenCalled();
      } finally {
        ambient.mockRestore();
      }
    },
  );

  it("keeps configured compat in published thinking metadata", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "vllm", "Qwen/Qwen3-8B");

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ]);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("uses only configured compat for a custom route when the catalog is loaded", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        name: "Qwen3",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "vllm", "Qwen/Qwen3-8B", {
      hasModelDirective: true,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ]);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("carries catalog context limits into cold model selection", async () => {
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 1_000_000,
        contextTokens: 272_000,
      },
    ]);

    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: {},
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: true,
    });

    expect(
      resolveContextTokens({
        cfg: {} as OpenClawConfig,
        provider: state.provider,
        model: state.model,
        modelContextWindow: state.modelContextWindow,
        modelContextTokens: state.modelContextTokens,
      }),
    ).toBe(272_000);
  });

  it.each([
    ["anthropic", "claude-opus-4-5", "openai/*", "gpt-5.5-codex", 1],
    ["openai/team", "claude-opus-4-5", "openai/*", "gpt-5.5-codex", 1],
    ["openai", "openai/team/Reader", "openai/team/*", "team/Reader", 1],
    ["openai", "team/Reader", "openai/team/*", "team/Reader", 0],
  ] as const)(
    "selects %s/%s with wildcard %s",
    async (defaultProvider, defaultModel, allow, selectedModel, catalogLoads) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      if (catalogLoads) {
        vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
          { provider: defaultProvider, id: defaultModel, name: "Configured primary" },
          { provider: "openai", id: selectedModel, name: "Allowed model" },
          { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
        ]);
      }
      const cfg = {
        agents: {
          defaults: {
            model: { primary: `${defaultProvider}/${defaultModel}` },
            models: { [allow]: {}, "vllm/*": {} },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, defaultProvider, defaultModel);

      expect(state.provider).toBe("openai");
      expect(state.model).toBe(selectedModel);
      expect(loadModelCatalogLocal).toHaveBeenCalledTimes(catalogLoads);
    },
  );

  it("does not reject wildcard-only policy before an explicit model directive is resolved", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "anthropic", "claude-opus-4-5", {
      hasModelDirective: true,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
    expect(state.allowedModelKeys.has("vllm/*")).toBe(true);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("keeps a stored dynamic provider wildcard model when the catalog has no rows yet", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      providerOverride: "vllm",
      modelOverride: "new-local-model",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };
    const sessionStore = { main: sessionEntry };

    const state = await createInitialState(cfg, "anthropic", "claude-opus-4-5", {
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(state.provider).toBe("vllm");
    expect(state.model).toBe("new-local-model");
    expect(state.requestedRouteResolution).toBe("resolved");
    expect(sessionStore.main.modelOverride).toBe("new-local-model");
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("preserves OpenAI API-key session auth when model policy explicitly pins OpenClaw", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "sk-test" },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai:work",
    };
    const sessionStore = { main: sessionEntry };

    await createModelSelectionState({
      agentId: "main",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(sessionEntry.authProfileOverride).toBe("openai:work");
    expect(sessionStore.main.authProfileOverride).toBe("openai:work");
  });
});

describe("resolveContextTokens", () => {
  it("prefers provider-qualified cache keys over bare model ids", () => {
    getContextWindowCaches().discoveredTokenCache.set("gemini-3.1-pro-preview", 200_000);
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview"),
      1_000_000,
    );

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });

    expect(result).toBe(1_000_000);
  });
});

describe("createModelSelectionState parent inheritance", () => {
  const defaultProvider = "openai";
  const defaultModel = "gpt-4o-mini";

  async function resolveState(params: {
    cfg: OpenClawConfig;
    sessionEntry: ReturnType<typeof makeEntry>;
    sessionStore: Record<string, ReturnType<typeof makeEntry>>;
    sessionKey: string;
    parentSessionKey?: string;
  }) {
    return createModelSelectionState({
      agentId: "main",
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
  }

  async function resolveStateWithParent(params: {
    cfg: OpenClawConfig;
    parentKey: string;
    sessionKey: string;
    parentEntry: ReturnType<typeof makeEntry>;
    sessionEntry?: ReturnType<typeof makeEntry>;
    parentSessionKey?: string;
  }) {
    const sessionEntry = params.sessionEntry ?? makeEntry();
    const sessionStore = {
      [params.parentKey]: params.parentEntry,
      [params.sessionKey]: sessionEntry,
    };
    return resolveState({
      cfg: params.cfg,
      sessionEntry,
      sessionStore,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
  }

  it.each([
    { source: "auto", origin: true, retained: true },
    { source: undefined, origin: true, retained: true },
    { source: "user", origin: true, retained: false },
    { source: "auto", origin: false, retained: false },
  ] as const)(
    "keeps direct automatic provenance source=$source origin=$origin",
    async ({ source, origin, retained }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-4o-mini",
            subagents: { model: "openai/gpt-4o" },
            modelPolicy: { allow: ["openai/gpt-4o-mini"] },
            models: { "openai/gpt-4o-mini": {}, "openai/gpt-4o": {} },
          },
        },
      };
      const sessionKey = "agent:main:subagent:automatic";
      const sessionEntry = makeEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        modelOverrideSource: source,
        ...(origin
          ? {
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: "gpt-4o",
            }
          : {}),
      });
      const state = await resolveState({
        cfg,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
      });
      expect(state.modelPolicy.allows({ provider: "openai", model: "gpt-4o" })).toBe(false);
      expect(state.provider).toBe("openai");
      expect(state.model).toBe(retained ? "gpt-4o" : "gpt-4o-mini");
      expect(sessionEntry.modelOverride).toBe(retained ? "gpt-4o" : undefined);
      if (retained) {
        expect(sessionEntry.modelOverrideSource).toBe(source);
        expect(sessionEntry.modelOverrideFallbackOriginProvider).toBe("openai");
        expect(sessionEntry.modelOverrideFallbackOriginModel).toBe("gpt-4o");
      }
    },
  );

  it("prefers child override over parent", async () => {
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      parentEntry,
      sessionEntry,
      sessionKey,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("ignores parent override when disallowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
    const state = await resolveStateWithParent({
      cfg,
      parentKey,
      sessionKey,
      parentEntry,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });
});

describe("createModelSelectionState respects session model override", () => {
  const defaultProvider = "inferencer";
  const defaultModel = "deepseek-v3-4bit-mlx";

  async function resolveState(sessionEntry: ReturnType<typeof makeEntry>) {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionStore = { [sessionKey]: sessionEntry };

    return createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });
  }

  it("respects modelOverride even when session model field differs", async () => {
    // From issue #14783: stored override should beat last-used fallback model.
    const state = await resolveState(
      makeEntry({
        model: "kimi-code",
        modelProvider: "kimi",
        contextTokens: 262_000,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
      }),
    );

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
  });

  it("uses default provider when providerOverride is not set but modelOverride is", async () => {
    const state = await resolveState(
      makeEntry({
        modelOverride: "deepseek-v3-4bit-mlx",
      }),
    );

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe("deepseek-v3-4bit-mlx");
  });

  it("preserves xai beta session overrides during allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "xai/grok-4",
          },
          models: {
            "xai/grok-4": {},
            "xai/grok-4.20-experimental-beta-0304-reasoning": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const sessionEntry = makeEntry({
      providerOverride: "xai",
      modelOverride: "grok-4.20-experimental-beta-0304-reasoning",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "xai",
      defaultModel: "grok-4",
      provider: "xai",
      model: "grok-4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("xai");
    expect(state.model).toBe("grok-4.20-experimental-beta-0304-reasoning");
    expect(state.resetModelOverride).toBe(false);
  });

  it("keeps provider-qualified stored overrides when providerOverride is also persisted", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:dashboard:child";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "openai/gpt-5.5",
      modelOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("openai/gpt-5.5");
  });

  it("normalizes provider-qualified parent stored overrides before allowlist checks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;
    const parentSessionKey = "agent:main:dashboard:parent";
    const sessionKey = "agent:main:dashboard:child";
    const sessionEntry = makeEntry();
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "openai/gpt-5.5",
      modelOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: sessionEntry, [parentSessionKey]: parentEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.4",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[parentSessionKey]?.modelOverride).toBe("openai/gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
  });

  it("clears disallowed model overrides and falls back to the default", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            fallbacks: ["openai/gpt-4o-mini"],
          },
          models: {
            "openai/gpt-4o": {},
          },
          modelPolicy: { allow: ["openai/gpt-4o"] },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openai/gpt-4o-mini");
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });

  it("preserves a locked disallowed override without resetting it", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:locked";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
      modelSelectionLocked: true,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o-mini");
    expect(sessionStore[sessionKey]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
      modelSelectionLocked: true,
    });
  });

  it("preserves a locked CLI runtime alias when its canonical model is allowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {},
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:plugin:anthropic:catalog-adopt:claude:test";
    const sessionEntry = makeEntry({
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-8",
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "native-claude-session",
          forceReuse: true,
          forkNextResume: true,
        },
      },
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      provider: "claude-cli",
      model: "claude-opus-4-8",
      hasModelDirective: false,
    });

    expect(state).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      resetModelOverride: false,
    });
    expect(sessionStore[sessionKey]).toMatchObject({
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-8",
      modelSelectionLocked: true,
    });
  });

  it.each([undefined, "gpt-4o", "stale-again"])(
    "adopts a concurrent model while repairing a stale override (automatic origin: %s)",
    async (automaticOrigin) => {
      const automatic = automaticOrigin !== undefined;
      const storePath = "sessions.json";
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4o" },
            modelPolicy: automatic ? { allow: ["openai/gpt-4o"] } : undefined,
            models: {
              "openai/gpt-4o": {},
              "openai/gpt-5.5": {},
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:telegram:direct:1";
      const sessionEntry = makeEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
        ...(automatic
          ? {
              modelOverrideSource: "auto" as const,
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: "stale-primary",
            }
          : {}),
      });
      const concurrentEntry = makeEntry({
        updatedAt: sessionEntry.updatedAt + 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: automatic ? "auto" : "user",
        ...(automatic
          ? {
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: automaticOrigin,
            }
          : {}),
      });
      sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
        status: "current",
        entry: concurrentEntry,
      });
      const sessionStore = { [sessionKey]: sessionEntry };

      const state = await createModelSelectionState({
        agentId: "main",
        cfg,
        agentCfg: cfg.agents?.defaults,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        provider: "openai",
        model: "gpt-4o-mini",
        hasModelDirective: false,
        isHeartbeat: automatic,
      });

      expect(state.modelPolicy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(!automatic);
      expect(state).toMatchObject({
        provider: "openai",
        model: automaticOrigin === "stale-again" ? "gpt-4o" : "gpt-5.5",
        resetModelOverride: false,
      });
      expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
      const persistenceRequest =
        sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
      expect(persistenceRequest).toMatchObject({
        storePath,
        sessionKey,
        initialEntry: expect.objectContaining({
          providerOverride: "openai",
          modelOverride: "gpt-4o-mini",
        }),
      });
      expect(persistenceRequest?.entry.providerOverride).toBeUndefined();
      expect(persistenceRequest?.entry.modelOverride).toBeUndefined();
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: automatic ? "auto" : "user",
      });
      expect(sessionStore[sessionKey]).toEqual(sessionEntry);
    },
  );

  it("rejects stale-model repair when the session rotates during persistence", async () => {
    const storePath = "sessions.json";
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const rotatedEntry = makeEntry({
      sessionId: "s2",
      updatedAt: sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
    });
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      entry: rotatedEntry,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    await expect(
      createModelSelectionState({
        agentId: "main",
        cfg,
        agentCfg: cfg.agents?.defaults,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        provider: "openai",
        model: "gpt-4o-mini",
        hasModelDirective: false,
      }),
    ).rejects.toThrow(/changed while starting work/i);

    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const persistenceRequest = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(persistenceRequest).toMatchObject({
      storePath,
      sessionKey,
      initialEntry: expect.objectContaining({
        sessionId: "s1",
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      }),
    });
    expect(persistenceRequest?.entry.providerOverride).toBeUndefined();
    expect(persistenceRequest?.entry.modelOverride).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    expect(sessionStore[sessionKey]).toBe(sessionEntry);
  });

  it("keeps wildcard-provider overrides when configured catalog rows are unavailable", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-added-after-startup",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-added-after-startup");
    expect(state.requestedRouteResolution).toBe("resolved");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-added-after-startup");
  });

  it("keeps allowed legacy combined session overrides after normalization", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": {},
            "ollama-beelink2/qwen2.5-coder:7b": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:telegram:direct:2";
    const sessionEntry = makeEntry({
      modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("ollama-beelink2");
    expect(state.model).toBe("qwen2.5-coder:7b");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverride).toBe("ollama-beelink2/qwen2.5-coder:7b");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
  });
});

describe("createModelSelectionState auto-failover overrides", () => {
  const defaultProvider = "mac-studio";
  const defaultModel = "MiniMax-M2.7-MLX";
  const sessionKey = "agent:main:telegram:direct:1";

  async function resolveStateWithOverride(params: {
    providerOverride: string;
    modelOverride: string;
    modelOverrideSource: "auto" | "user" | undefined;
    modelOverrideRouteResolution?: "resolved";
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    fallbackNoticeSelectedModel?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user";
    provider?: string;
    model?: string;
    primaryProvider?: string;
    primaryModel?: string;
    isHeartbeat?: boolean;
    skipStoredModelOverride?: boolean;
  }) {
    const cfg = {} as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: params.providerOverride,
      modelOverride: params.modelOverride,
      modelOverrideSource: params.modelOverrideSource,
      modelOverrideRouteResolution: params.modelOverrideRouteResolution,
      modelOverrideFallbackOriginProvider: params.modelOverrideFallbackOriginProvider,
      modelOverrideFallbackOriginModel: params.modelOverrideFallbackOriginModel,
      fallbackNotice: params.fallbackNoticeSelectedModel
        ? {
            kind: "active",
            selectedModel: params.fallbackNoticeSelectedModel,
            activeModel: `${params.providerOverride}/${params.modelOverride}`,
          }
        : undefined,
      authProfileOverride: params.authProfileOverride,
      authProfileOverrideSource: params.authProfileOverrideSource,
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      primaryProvider: params.primaryProvider,
      primaryModel: params.primaryModel,
      provider: params.provider ?? defaultProvider,
      model: params.model ?? defaultModel,
      hasModelDirective: false,
      isHeartbeat: params.isHeartbeat,
      skipStoredModelOverride: params.skipStoredModelOverride,
    });
    return { state, sessionEntry, sessionStore };
  }

  it("clears legacy auto-failover overrides without origin metadata on normal turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openrouter/minimax/minimax-m2.7");
  });

  it("preserves auto-failover overrides that still carry origin metadata on normal turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("keeps a legacy auto pin when the current selection already matches it", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("clears stale auto-created legacy openai route pins when primary is canonical openai", async () => {
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 350_000,
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openai/gpt-5.5");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();
    expect(sessionStore[sessionKey]?.model).toBeUndefined();
    expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBeUndefined();
  });

  it("preserves usable Codex auth while clearing stale legacy openai route pins", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "test-key",
        },
      },
    };
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("openai:default");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("auto");
  });

  it("keeps auto openai pins when canonical openai uses a custom API route", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("keeps explicit user openai route overrides", async () => {
    const sessionEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-5.5");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openai");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-5.5");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("user");
  });

  it("still clears disallowed auto-failover overrides through allowlist validation", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: `${defaultProvider}/${defaultModel}` },
          models: {
            [`${defaultProvider}/${defaultModel}`]: {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider,
      defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      hasModelDirective: false,
    });

    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
  });

  it("can suppress a stored auto-failover override for a primary recovery probe", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      authProfileOverride: "openrouter:fallback",
      authProfileOverrideSource: "auto",
      provider: defaultProvider,
      model: defaultModel,
      skipStoredModelOverride: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("openrouter:fallback");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("auto");
  });

  it("clears stale heartbeat auto-failover override when the fallback origin changed", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.3",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideRef).toBe("openrouter/minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideFallbackOriginModel).toBeUndefined();
  });

  it("preserves user auth profile when clearing a stale heartbeat auto-failover override", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "mac-studio:local": {
          type: "api_key",
          provider: defaultProvider,
          key: "test-key",
        },
      },
    };
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.3",
      authProfileOverride: "mac-studio:local",
      authProfileOverrideSource: "user",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("mac-studio:local");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("user");
  });

  it("keeps heartbeat auto-failover override when the fallback origin still matches default", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: defaultProvider,
      modelOverrideFallbackOriginModel: defaultModel,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
  });

  it("keeps heartbeat auto-failover override when the origin matches the channel primary", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
  });

  it("keeps recovered heartbeat auto-failover override without modelOverrideSource", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: undefined,
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
  });

  it("clears legacy heartbeat auto-failover override when no origin metadata exists", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBeUndefined();
  });

  it("uses fallback notice metadata for legacy heartbeat auto-failover overrides", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      fallbackNoticeSelectedModel: `${defaultProvider}/${defaultModel}`,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
    expect(sessionStore[sessionKey]?.modelOverrideSource).toBe("auto");
  });

  it("preserves a user-selected override across turns", async () => {
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });

    // User-selected override must persist.
    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.requestedRouteResolution).toBe("resolved");
    expect(sessionStore[sessionKey]?.providerOverride).toBe("openrouter");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
  });

  it("preserves a legacy override with no modelOverrideSource (treated as user)", async () => {
    // Sessions persisted before modelOverrideSource was introduced lack the field.
    // Backward-compat rule: missing source + present override = user selection.
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: undefined,
    });

    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    expect(state.requestedRouteResolution).toBe("resolved");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("minimax/minimax-m2.7");
    expect(state.resetModelOverride).toBe(false);
  });

  it("keeps a canonical stored route ahead of a colliding bare alias", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3.1-pro-preview", fallbacks: [] },
          models: {
            "google/gemini-2.5-flash-lite": { alias: "google-flash-lite" },
            "openrouter/google/gemini-2.5-flash-lite": {
              alias: "gemini-2.5-flash-lite",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "google",
      modelOverride: "gemini-2.5-flash-lite",
      modelOverrideSource: "user",
    });
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "google",
      defaultModel: "gemini-3.1-pro-preview",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      hasModelDirective: false,
    });

    expect(state).toMatchObject({
      provider: "google",
      model: "gemini-2.5-flash-lite",
      requestedRouteResolution: "resolved",
    });
  });

  it("canonicalizes a reset-upgraded legacy alias before fallback", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "legacy-fast-model" },
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "legacy-fast-model",
      // Older resets added the source without resolving the stored alias.
      modelOverrideSource: "user",
    });
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hasModelDirective: false,
    });

    expect(state).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      requestedRouteResolution: "resolved",
    });
  });

  it("does not touch an auto-failover override inherited from a parent session", async () => {
    // Auto clearing only applies to a direct session override, not one inherited
    // from a parent. The parent's own session state is managed separately.
    const cfg = {} as OpenClawConfig;
    const parentKey = "agent:main:telegram:direct:1";
    const childKey = "agent:main:telegram:direct:1:thread:99";
    const parentEntry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
    });
    const childEntry = makeEntry(); // no override of its own
    const sessionStore = { [parentKey]: parentEntry, [childKey]: childEntry };

    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry: childEntry,
      sessionStore,
      sessionKey: childKey,
      parentSessionKey: parentKey,
      defaultProvider,
      defaultModel,
      provider: defaultProvider,
      model: defaultModel,
      hasModelDirective: false,
    });

    // Parent auto-override is applied to the child (it has no direct override).
    expect(state.provider).toBe("openrouter");
    expect(state.model).toBe("minimax/minimax-m2.7");
    // Parent session entry is not modified by the child's selection logic.
    expect(sessionStore[parentKey]?.providerOverride).toBe("openrouter");
    expect(state.resetModelOverride).toBe(false);
  });
});

describe("createModelSelectionState auth-profile override flapping regression", () => {
  const sessionKey = "agent:main:telegram:direct:1";

  it("keeps alias-compatible authProfileOverride when stored credential provider is 'anthropic' for a claude-cli session", async () => {
    // Regression: the old code compared profile.provider directly to acceptedAuthProviders,
    // which cleared an 'anthropic' credential when the session ran under the 'claude-cli'
    // provider. The alias (claude-cli -> anthropic) must be respected so the override is kept.
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "api_key",
          provider: "anthropic",
          key: "test-cli-oauth-token",
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "s-cli",
      updatedAt: 1,
      authProfileOverride: "anthropic:claude-cli",
    };
    const sessionStore = { [sessionKey]: sessionEntry };

    await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "claude-cli",
      defaultModel: "claude-opus-4-7",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      hasModelDirective: false,
    });

    // The override must NOT have been cleared — the anthropic credential is
    // alias-compatible with the claude-cli provider.
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("anthropic:claude-cli");
    expect(sessionEntry.authProfileOverride).toBe("anthropic:claude-cli");
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("uses published reasoning without a second manifest inventory", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "local", id: "fast-reasoner", name: "Fast Reasoner", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "local",
      defaultModel: "fast-reasoner",
      provider: "local",
      model: "fast-reasoner",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledOnce();
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      agentId: "main",
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});

describe("createModelSelectionState degraded-catalog override preservation", () => {
  const sessionKey = "agent:main:discord:channel:g1";
  // The `anthropic/*` wildcard (a non-default provider) forces the live catalog
  // load path (`needsModelCatalog`), which is the only path where a degraded
  // catalog can transiently drop a pin. Every test must load the snapshot so its
  // one-time mock is consumed and cannot leak into a sibling test.
  //
  // Allow-list without gpt-4o, so the pinned override reads as "not allowed"
  // whenever the catalog cannot vouch for it. The authoritative flag then
  // decides whether that reads as a genuine disallow or a transient outage.
  const restrictiveCfg = {
    agents: { defaults: { models: { "openai/gpt-4o-mini": {}, "anthropic/*": {} } } },
  } as unknown as OpenClawConfig;
  // Permissive allow-list that keeps gpt-4o allowed regardless of the catalog.
  const permissiveCfg = {
    agents: {
      defaults: { models: { "openai/gpt-4o": {}, "openai/gpt-4o-mini": {}, "anthropic/*": {} } },
    },
  } as unknown as OpenClawConfig;

  const makeOverrideEntry = (): SessionEntry => ({
    sessionId: "session-id",
    updatedAt: Date.now(),
    providerOverride: "openai",
    modelOverride: "gpt-4o",
    modelOverrideSource: "user",
  });

  async function run(params: {
    cfg: OpenClawConfig;
    snapshotEntries: unknown[];
    authoritative: boolean;
    modelSelectionLocked?: true;
  }): Promise<{
    state: Awaited<ReturnType<typeof createModelSelectionState>>;
    sessionEntry: SessionEntry;
  }> {
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockResolvedValueOnce({
      entries: params.snapshotEntries,
      routeVariants: params.snapshotEntries,
      authoritative: params.authoritative,
    });
    const sessionEntry = {
      ...makeOverrideEntry(),
      ...(params.modelSelectionLocked ? { modelSelectionLocked: true as const } : {}),
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const state = await createModelSelectionState({
      agentId: "main",
      cfg: params.cfg,
      agentCfg: params.cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      primaryProvider: "openai",
      primaryModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    return { state, sessionEntry };
  }

  it("preserves a pin the degraded catalog cannot vouch for", async () => {
    // Degraded snapshot: we cannot prove the pin is really disallowed, so keep it.
    const { state, sessionEntry } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [],
      authoritative: false,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBe("temporarily-unavailable");
    expect(state.resetModelOverrideRef).toBe("openai/gpt-4o");
    // The pin is untouched and the turn falls back to primary.
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(state.model).toBe("gpt-4o-mini");
  });

  it("keeps a locked pin active without a degraded-catalog fallback notice", async () => {
    const { state, sessionEntry } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [],
      authoritative: false,
      modelSelectionLocked: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.resetModelOverrideRef).toBeUndefined();
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
    expect(state.model).toBe("gpt-4o");
  });

  it("destroys a genuinely-disallowed pin on an authoritative catalog", async () => {
    // Same disallowed pin, but an authoritative catalog proves it is gone.
    const { state } = await run({
      cfg: restrictiveCfg,
      snapshotEntries: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }],
      authoritative: true,
    });
    expect(state.resetModelOverrideReason).toBe("disallowed");
    expect(state.resetModelOverride).toBe(true);
  });

  it("keeps a configured pin that is present on an authoritative catalog", async () => {
    const { state } = await run({
      cfg: permissiveCfg,
      snapshotEntries: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
      ],
      authoritative: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.model).toBe("gpt-4o");
  });
});

describe("createModelSelectionState disallowed override fallback target", () => {
  // A rejected override must land on the agent's configured primary, not on the first allowed
  // entry in the catalog. `provider-a` is declared first in `models.providers` and first in the
  // allow list, so an accidental first-entry fallback picks `provider-a/model-a1` either way,
  // while the configured primary is `provider-b/model-b1`.
  const sessionKey = "agent:main:discord:channel:g2";
  const cfg = {
    agents: {
      defaults: {
        model: "provider-b/model-b1",
        modelPolicy: { allow: ["provider-a/model-a1", "provider-b/model-b1"] },
      },
    },
    models: {
      providers: {
        "provider-a": {
          api: "openai-responses",
          baseUrl: "https://provider-a.example/v1",
          models: [{ id: "model-a1", name: "Provider A Model 1" }],
        },
        "provider-b": {
          api: "openai-responses",
          baseUrl: "https://provider-b.example/v1",
          models: [{ id: "model-b1", name: "Provider B Model 1" }],
        },
      },
    },
  } as unknown as OpenClawConfig;

  async function runRejectedStoredOverride(
    persistedEntry?: SessionEntry,
    source: "direct" | "parent" | "degraded" = "direct",
  ): Promise<{
    state: Awaited<ReturnType<typeof createModelSelectionState>>;
    sessionEntry: SessionEntry;
  }> {
    const sessionEntry: SessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "user",
    };
    const parentSessionKey = "agent:main:parent";
    const pinnedEntry = { ...sessionEntry };
    if (source === "parent") {
      delete sessionEntry.providerOverride;
      delete sessionEntry.modelOverride;
      delete sessionEntry.modelOverrideSource;
    }
    const sessionStore = { [sessionKey]: sessionEntry, [parentSessionKey]: pinnedEntry };
    if (persistedEntry) {
      // A concurrent writer won the reset's compare-and-swap and the row still holds the pin.
      sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
        status: "current",
        entry: persistedEntry,
      });
    }
    // The reply owner seeds provider/model from the stored override before selection runs.
    const state = await createModelSelectionState({
      agentId: "main",
      cfg:
        source === "degraded"
          ? {
              ...cfg,
              agents: {
                defaults: {
                  ...cfg.agents?.defaults,
                  modelPolicy: { allow: ["provider-a/*", "provider-b/model-b1"] },
                },
              },
            }
          : cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey: source === "parent" ? parentSessionKey : undefined,
      ...(source === "degraded"
        ? {
            preparedModelCatalog: {
              authoritative: false,
              entries: [
                { provider: "provider-a", id: "model-a1", name: "First" },
                { provider: "provider-b", id: "model-b1", name: "Primary" },
              ],
              routeVariants: [],
            },
          }
        : {}),
      ...(persistedEntry ? { storePath: "sessions.json" } : {}),
      defaultProvider: "provider-b",
      defaultModel: "model-b1",
      primaryProvider: "provider-b",
      primaryModel: "model-b1",
      provider: "provider-c",
      model: "model-c1",
      hasModelDirective: false,
    });
    if (source === "parent") {
      expect(sessionStore[parentSessionKey]).toMatchObject({
        providerOverride: "provider-c",
        modelOverride: "model-c1",
        modelOverrideSource: "user",
      });
      expect(sessionEntry.modelOverride).toBeUndefined();
    }
    return { state, sessionEntry };
  }

  it("resets a disallowed stored override to the configured primary", async () => {
    const { state, sessionEntry } = await runRejectedStoredOverride();
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideReason).toBe("disallowed");
    expect(state.resetModelOverrideRef).toBe("provider-c/model-c1");
    // provider-a/model-a1 is the first allowed catalog entry; the primary must still win.
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
    // The run and the session the next turn reads agree on the reset target.
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it.each(["parent", "degraded"] as const)(
    "uses the primary without clearing a refused %s pin",
    async (source) => {
      const { state, sessionEntry } = await runRejectedStoredOverride(undefined, source);
      expect(state).toMatchObject({
        provider: "provider-b",
        model: "model-b1",
        resetModelOverride: false,
        resetModelOverrideRef: "provider-c/model-c1",
        resetModelOverrideReason: source === "parent" ? "disallowed" : "temporarily-unavailable",
      });
      if (source === "degraded") {
        expect(sessionEntry.modelOverride).toBe("model-c1");
        expect(sessionEntry.modelOverrideSource).toBe("user");
      }
    },
  );

  it("keeps the configured primary when the reset loses the persistence race", async () => {
    // The refusal is a decision this call already made, so a lost compare-and-swap must not send
    // the turn to the first allowed catalog entry while the row still holds the refused override.
    const { state, sessionEntry } = await runRejectedStoredOverride({
      sessionId: "session-id",
      updatedAt: Date.now() + 1,
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "user",
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
    // The refused override survives on the row for the next turn to retry the reset.
    expect(sessionEntry.modelOverride).toBe("model-c1");
  });

  it("keeps the stale primary fallback for a caller without a session store", async () => {
    // A session store is optional, and the reset block needs one, so a caller that omits it cannot
    // reset anything. The stale primary fallback predates that block and must keep firing for it.
    const sessionEntry: SessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      modelOverrideFallbackOriginProvider: "provider-c",
      modelOverrideFallbackOriginModel: "model-c2",
    };
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      defaultProvider: "provider-b",
      defaultModel: "model-b1",
      primaryProvider: "provider-b",
      primaryModel: "model-b1",
      provider: "provider-c",
      model: "model-c1",
      hasModelDirective: false,
      isHeartbeat: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

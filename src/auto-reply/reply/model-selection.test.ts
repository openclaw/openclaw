// Tests model selection resolution from directives, config, and session state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextWindowCaches } from "../../agents/context-cache.js";
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
      const entries = await loadModelCatalog(params);
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

const sessionKey = "agent:main:telegram:direct:1";
type SelectionOptions = Partial<Parameters<typeof createModelSelectionState>[0]>;

function selectSession(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  entry: SessionEntry,
  options: SelectionOptions = {},
) {
  const key = options.sessionKey ?? sessionKey;
  return createInitialState(cfg, provider, model, {
    sessionEntry: entry,
    sessionStore: { [key]: entry },
    sessionKey: key,
    ...options,
  });
}

describe("catalog and thinking selection", () => {
  it("retains prepared automatic-primary reasoning outside manual policy", async () => {
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
        defaults: { model: "fixture/automatic", modelPolicy: { allow: ["fixture/manual"] } },
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
    const state = await createInitialState(cfg, "fixture", "automatic", {
      preparedModelCatalog: { entries: [automatic], routeVariants: [] },
    });
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
  });

  it("uses configured thinking without loading the full catalog", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg: OpenClawConfig = {
      agents: { defaults: { thinkingDefault: "low", models: { "openai/gpt-5.4": {} } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    };
    const state = await createInitialState(cfg, "openai", "gpt-5.4");
    expect(state.allowedModelKeys.has("openai/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("hydrates thinking separately for embedded and native runtimes", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    ]);
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel({ reasoning: undefined })],
          },
        },
      },
    };
    const state = await createInitialState(cfg, "openai", "gpt-5.4", {
      preparedModelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: false }],
        routeVariants: [],
      },
    });
    await state.resolveThinkingCatalog({
      provider: "openai",
      model: "gpt-5.4",
      agentRuntime: "openclaw",
    });
    await expect(
      state.resolveDefaultThinkingLevel({
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: "codex",
      }),
    ).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      agentRuntime: "codex",
    });
  });

  it("reloads embedded metadata when clearing a native runtime pin", async () => {
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

  it("uses provider-specific prepared prompt budgets without an authored provider", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
    const entries = [
      {
        provider: "fixture-secondary",
        id: "shared-model",
        name: "Shared",
        reasoning: false,
        contextWindow: 1_050_000,
        contextTokens: 922_000,
      },
      {
        provider: "fixture-primary",
        id: "shared-model",
        name: "Shared",
        reasoning: false,
        contextWindow: 1_000_000,
        contextTokens: 872_000,
      },
    ];
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "fixture-primary/shared-model": {} } } },
    };
    const state = await createInitialState(cfg, "fixture-primary", "shared-model", {
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
    ).toBe(872_000);
    expect(await state.resolveThinkingCatalog()).toEqual(entries);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  });

  it("preserves literal catalog identities despite a shared display key", async () => {
    const models = [
      makeConfiguredModel({ id: "m", contextWindow: 1_000_000 }),
      makeConfiguredModel({ id: "fixture/m", contextWindow: 64_000 }),
    ];
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
    const state = await createInitialState(cfg, "fixture", "fixture/m", {
      preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
    });
    expect(state.modelContextWindow).toBe(64_000);
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
    ).toBe(64_000);
  });

  it.each([
    { hasModelDirective: true, capturedPolicy: true, expected: "ultra", unrestricted: false },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium", unrestricted: true },
  ])("keeps prepared thinking ownership (captured=$capturedPolicy)", async (fixture) => {
    const provider = "fixture-provider";
    const model = "fixture-model";
    const cfg: OpenClawConfig = {
      agents: fixture.unrestricted
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
            ...(fixture.capturedPolicy
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
        hasModelDirective: fixture.hasModelDirective,
        preparedModelCatalog,
      });
      await expect(
        state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
      ).resolves.toBe(fixture.expected);
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      ambient.mockRestore();
    }
  });

  it("uses configured compat for a custom route despite loaded catalog compat", async () => {
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
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "vllm/Qwen/Qwen3-8B": {} } } },
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
    };
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

  it.each([
    ["anthropic", "claude-opus-4-5", "openai/*", "gpt-5.5-codex", 1],
    ["openai", "team/Reader", "openai/team/*", "team/Reader", 0],
  ] as const)("selects %s/%s with wildcard %s", async (provider, model, allow, selected, loads) => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    if (loads) {
      vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
        { provider, id: model, name: "Primary" },
        { provider: "openai", id: selected, name: "Allowed" },
        { provider: "vllm", id: "qwen3-local", name: "Local" },
      ]);
    }
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: `${provider}/${model}` },
          models: { [allow]: {}, "vllm/*": {} },
        },
      },
    };
    const state = await createInitialState(cfg, provider, model);
    expect(state).toMatchObject({ provider: "openai", model: selected });
    expect(loadModelCatalogLocal).toHaveBeenCalledTimes(loads);
  });

  it("returns reasoning off when no capability is published", async () => {
    const state = await createInitialState({}, "openai", "gpt-4o-mini");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});

describe("session override precedence and persistence", () => {
  it("prefers the child's override to both its last-used fallback and the parent's pin", async () => {
    const parentKey = "agent:main:telegram:group:123";
    const childKey = `${parentKey}:topic:99`;
    const entry = makeEntry({
      model: "kimi-code",
      modelProvider: "kimi",
      contextTokens: 262_000,
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
    });
    const state = await selectSession({}, "inferencer", "deepseek-v3-4bit-mlx", entry, {
      sessionKey: childKey,
      sessionStore: {
        [childKey]: entry,
        [parentKey]: makeEntry({ providerOverride: "openai", modelOverride: "gpt-4o" }),
      },
    });
    expect(state).toMatchObject({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  it.each([undefined, "gpt-4o", "stale-again"])(
    "adopts concurrent repair state (automatic origin: %s)",
    async (automaticOrigin) => {
      const automatic = automaticOrigin !== undefined;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4o" },
            modelPolicy: automatic ? { allow: ["openai/gpt-4o"] } : undefined,
            models: { "openai/gpt-4o": {}, "openai/gpt-5.5": {} },
          },
        },
      };
      const entry = makeEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
        ...(automatic
          ? {
              modelOverrideSource: "auto",
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: "stale-primary",
            }
          : {}),
      });
      const concurrentEntry = makeEntry({
        updatedAt: entry.updatedAt + 1,
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
      const sessionStore = { [sessionKey]: entry };
      const state = await selectSession(cfg, "openai", "gpt-4o", entry, {
        sessionStore,
        storePath: "sessions.json",
        model: "gpt-4o-mini",
        isHeartbeat: automatic,
      });
      expect(state.modelPolicy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(!automatic);
      expect(state).toMatchObject({
        provider: "openai",
        model: automaticOrigin === "stale-again" ? "gpt-4o" : "gpt-5.5",
        resetModelOverride: false,
      });
      expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
      const request = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        storePath: "sessions.json",
        sessionKey,
        initialEntry: expect.objectContaining({
          providerOverride: "openai",
          modelOverride: "gpt-4o-mini",
        }),
      });
      expect(request?.entry.providerOverride).toBeUndefined();
      expect(request?.entry.modelOverride).toBeUndefined();
      expect(entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: automatic ? "auto" : "user",
      });
      expect(sessionStore[sessionKey]).toEqual(entry);
    },
  );

  it("rejects repair when the session rotates during persistence", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o" },
          models: { "openai/gpt-4o": {} },
        },
      },
    };
    const entry = makeEntry({
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      entry: makeEntry({
        sessionId: "s2",
        updatedAt: entry.updatedAt + 1,
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        modelOverrideSource: "user",
      }),
    });
    const sessionStore = { [sessionKey]: entry };
    await expect(
      selectSession(cfg, "openai", "gpt-4o", entry, {
        sessionStore,
        storePath: "sessions.json",
        model: "gpt-4o-mini",
      }),
    ).rejects.toThrow(/changed while starting work/i);
    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const request = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      storePath: "sessions.json",
      sessionKey,
      initialEntry: expect.objectContaining({
        sessionId: "s1",
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      }),
    });
    expect(request?.entry.providerOverride).toBeUndefined();
    expect(request?.entry.modelOverride).toBeUndefined();
    expect(entry).toMatchObject({
      sessionId: "s1",
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    expect(sessionStore[sessionKey]).toBe(entry);
  });
});

describe("automatic fallback provenance", () => {
  const provider = "mac-studio";
  const model = "MiniMax-M2.7-MLX";
  type FallbackCase = {
    name: string;
    entry?: Partial<SessionEntry>;
    options?: SelectionOptions;
    reset?: boolean;
    usePrimary?: boolean;
  };
  it.each<FallbackCase>([
    { name: "clears a legacy pin on a normal turn", reset: true, usePrimary: true },
    {
      name: "preserves a pin and its auth during a primary recovery probe",
      usePrimary: true,
      entry: {
        modelOverrideFallbackOriginProvider: provider,
        modelOverrideFallbackOriginModel: model,
        authProfileOverride: "openrouter:fallback",
        authProfileOverrideSource: "auto",
      },
      options: { skipStoredModelOverride: true },
    },
    {
      name: "recovers source-less provenance against the channel primary",
      entry: {
        modelOverrideSource: undefined,
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o",
      },
      options: {
        isHeartbeat: true,
        primaryProvider: "openai",
        primaryModel: "gpt-4o",
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
      },
    },
    {
      name: "clears a heartbeat pin without origin metadata",
      reset: true,
      usePrimary: true,
      options: { isHeartbeat: true, provider: "openrouter", model: "minimax/minimax-m2.7" },
    },
    {
      name: "recovers a legacy heartbeat origin from its notice",
      entry: {
        fallbackNotice: {
          kind: "active",
          selectedModel: `${provider}/${model}`,
          activeModel: "openrouter/minimax/minimax-m2.7",
        },
      },
      options: { isHeartbeat: true, provider: "openrouter", model: "minimax/minimax-m2.7" },
    },
  ])("$name", async (fixture) => {
    const entry = makeEntry({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      ...fixture.entry,
    });
    const before = { ...entry };
    const state = await selectSession({}, provider, model, entry, fixture.options);
    expect(state).toMatchObject({
      provider: fixture.usePrimary ? provider : "openrouter",
      model: fixture.usePrimary ? model : "minimax/minimax-m2.7",
      resetModelOverride: fixture.reset === true,
    });
    if (fixture.reset) {
      expect(state.resetModelOverrideRef).toBe("openrouter/minimax/minimax-m2.7");
      expect(entry.providerOverride).toBeUndefined();
      expect(entry.modelOverride).toBeUndefined();
      expect(entry.modelOverrideSource).toBeUndefined();
    } else {
      expect(entry).toEqual(before);
    }
  });

  it.each([false, true])(
    "clears a stale OpenAI pin while retaining eligible auth=%s",
    async (usableAuth) => {
      if (usableAuth) {
        authProfileStoreMock.store = {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
          },
        };
      }
      const entry = makeEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 350_000,
        authProfileOverride: "openai:default",
        authProfileOverrideSource: "auto",
      });
      const state = await selectSession({}, "openai", "gpt-5.5", entry);
      expect(state).toMatchObject({
        provider: "openai",
        model: "gpt-5.5",
        resetModelOverride: true,
        resetModelOverrideRef: "openai/gpt-5.5",
      });
      expect(entry.providerOverride).toBeUndefined();
      expect(entry.modelOverride).toBeUndefined();
      expect(entry.modelOverrideSource).toBeUndefined();
      expect(entry.modelProvider).toBeUndefined();
      expect(entry.model).toBeUndefined();
      expect(entry.contextTokens).toBeUndefined();
      expect(entry.authProfileOverride).toBe(usableAuth ? "openai:default" : undefined);
      expect(entry.authProfileOverrideSource).toBe(usableAuth ? "auto" : undefined);
    },
  );

  it("keeps an automatic OpenAI pin on a custom API route", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
    };
    const entry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
    });
    const before = { ...entry };
    const state = await selectSession(cfg, "openai", "gpt-5.5", entry);
    expect(state).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      resetModelOverride: false,
    });
    expect(entry).toEqual(before);
  });

  it.each<{
    name: string;
    provider: string;
    model: string;
    pin: string;
    expected: string;
    models: Record<string, { alias: string }>;
  }>([
    {
      name: "keeps a canonical route ahead of a colliding bare alias",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      pin: "gemini-2.5-flash-lite",
      expected: "gemini-2.5-flash-lite",
      models: {
        "google/gemini-2.5-flash-lite": { alias: "google-flash-lite" },
        "openrouter/google/gemini-2.5-flash-lite": { alias: "gemini-2.5-flash-lite" },
      },
    },
    {
      name: "canonicalizes a reset-upgraded legacy alias",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      pin: "legacy-fast-model",
      expected: "claude-sonnet-4-6",
      models: { "anthropic/claude-sonnet-4-6": { alias: "legacy-fast-model" } },
    },
  ])("$name", async (fixture) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: `${fixture.provider}/${fixture.model}`, fallbacks: [] },
          models: fixture.models,
        },
      },
    };
    const entry = makeEntry({
      providerOverride: fixture.provider,
      modelOverride: fixture.pin,
      modelOverrideSource: "user",
    });
    const state = await selectSession(cfg, fixture.provider, fixture.model, entry);
    expect(state).toMatchObject({
      provider: fixture.provider,
      model: fixture.expected,
      requestedRouteResolution: "resolved",
    });
  });
});

it("keeps alias-compatible Anthropic auth for a CLI session", async () => {
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
  const entry = makeEntry({ authProfileOverride: "anthropic:claude-cli" });
  const sessionStore = { [sessionKey]: entry };
  await selectSession({}, "claude-cli", "claude-opus-4-7", entry, { sessionStore });
  expect(entry.authProfileOverride).toBe("anthropic:claude-cli");
  expect(sessionStore[sessionKey]?.authProfileOverride).toBe("anthropic:claude-cli");
});

it("keeps a locked pin active without a degraded-catalog fallback notice", async () => {
  catalogRuntimeMocks.loadModelCatalogSnapshot.mockResolvedValueOnce({
    entries: [],
    routeVariants: [],
    authoritative: false,
  });
  const cfg: OpenClawConfig = {
    agents: { defaults: { models: { "openai/gpt-4o-mini": {}, "anthropic/*": {} } } },
  };
  const entry = makeEntry({
    providerOverride: "openai",
    modelOverride: "gpt-4o",
    modelOverrideSource: "user",
    modelSelectionLocked: true,
  });
  const state = await selectSession(cfg, "openai", "gpt-4o-mini", entry);
  expect(state.resetModelOverride).toBe(false);
  expect(state.resetModelOverrideReason).toBeUndefined();
  expect(state.resetModelOverrideRef).toBeUndefined();
  expect(state.model).toBe("gpt-4o");
  expect(entry.modelOverride).toBe("gpt-4o");
});

describe("refused pins use the primary instead of catalog order", () => {
  const cfg: OpenClawConfig = {
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
          models: [makeConfiguredModel({ id: "model-a1", name: "Provider A" })],
        },
        "provider-b": {
          api: "openai-responses",
          baseUrl: "https://provider-b.example/v1",
          models: [makeConfiguredModel({ id: "model-b1", name: "Provider B" })],
        },
      },
    },
  };

  it.each(["direct", "parent", "degraded", "concurrent"] as const)(
    "uses the primary for a refused %s pin",
    async (source) => {
      const pin = makeEntry({
        providerOverride: "provider-c",
        modelOverride: "model-c1",
        modelOverrideSource: "user",
      });
      const entry = source === "parent" ? makeEntry() : { ...pin };
      const parentSessionKey = "agent:main:parent";
      const sessionStore = { [sessionKey]: entry, [parentSessionKey]: pin };
      if (source === "concurrent") {
        sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
          status: "current",
          entry: { ...pin, updatedAt: pin.updatedAt + 1 },
        });
      }
      const state = await selectSession(
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
        "provider-b",
        "model-b1",
        entry,
        {
          agentCfg: cfg.agents?.defaults,
          sessionStore,
          parentSessionKey: source === "parent" ? parentSessionKey : undefined,
          provider: "provider-c",
          model: "model-c1",
          ...(source === "concurrent" ? { storePath: "sessions.json" } : {}),
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
        },
      );
      expect(state).toMatchObject({
        provider: "provider-b",
        model: "model-b1",
        resetModelOverride: source === "direct",
      });
      expect(state.resetModelOverrideReason).toBe(
        source === "concurrent"
          ? undefined
          : source === "degraded"
            ? "temporarily-unavailable"
            : "disallowed",
      );
      if (source !== "concurrent") {
        expect(state.resetModelOverrideRef).toBe("provider-c/model-c1");
      }
      if (source === "direct" || source === "parent") {
        expect(entry.modelOverride).toBeUndefined();
        expect(entry.providerOverride).toBeUndefined();
      } else {
        expect(entry.modelOverride).toBe("model-c1");
        expect(entry.modelOverrideSource).toBe("user");
      }
      if (source === "parent") {
        expect(sessionStore[parentSessionKey]).toMatchObject({
          providerOverride: "provider-c",
          modelOverride: "model-c1",
          modelOverrideSource: "user",
        });
      }
    },
  );

  it("uses the primary for a stale caller without a session store", async () => {
    const entry = makeEntry({
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      modelOverrideFallbackOriginProvider: "provider-c",
      modelOverrideFallbackOriginModel: "model-c2",
    });
    const state = await createInitialState(cfg, "provider-b", "model-b1", {
      sessionEntry: entry,
      provider: "provider-c",
      model: "model-c1",
      isHeartbeat: true,
    });
    expect(state).toMatchObject({
      resetModelOverride: false,
      provider: "provider-b",
      model: "model-b1",
    });
  });
});

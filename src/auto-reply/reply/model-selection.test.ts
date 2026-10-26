import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { getContextWindowCaches } from "../../agents/context-cache.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { isThinkingLevelSupported } from "../thinking.js";
import { prepareModelSelectionRuntime } from "./model-runtime-normalization.js";
import {
  createInitialState,
  makeConfiguredModel,
  makeEntry,
} from "./model-selection.inputs.test-support.js";
import { createModelSelectionState } from "./model-selection.js";

type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
]);

const { persist } = vi.hoisted(() => ({ persist: vi.fn<PersistReplySessionEntry>() }));

const catalogMocks = vi.hoisted(() => ({
  loadModelCatalog: async () => DEFAULT_MOCK_CATALOG_ENTRIES,
  loadModelCatalogSnapshot: vi.fn(async () => ({
    entries: DEFAULT_MOCK_CATALOG_ENTRIES,
    routeVariants: DEFAULT_MOCK_CATALOG_ENTRIES,
    authoritative: true,
  })),
}));

// mock-isolation: Model selection consumes this fixture's prepared catalog without provider discovery.
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: catalogMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogMocks.loadModelCatalogSnapshot,
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

// mock-isolation: Selection assertions observe persistence requests without writing operator state.
vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: persist,
}));

const authMocks = vi.hoisted(() => {
  const state: {
    store: {
      version: 1;
      profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
    };
  } = { store: { version: 1, profiles: {} } };
  const prepareAuthProfileProvider = vi.fn(async (): Promise<{ provider: string | undefined }> => ({
    provider: undefined,
  }));
  return Object.assign(state, {
    ensureAuthProfileStoreAsync: () => state.store,
    prepareAuthProfileProvider,
    reset() {
      state.store = { version: 1, profiles: {} };
      prepareAuthProfileProvider.mockReset().mockResolvedValue({ provider: undefined });
    },
  });
});

vi.mock("../../agents/auth-profiles.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.runtime.js")>()),
  ensureAuthProfileStoreAsync: authMocks.ensureAuthProfileStoreAsync,
  prepareAuthProfileProvider: authMocks.prepareAuthProfileProvider,
}));

afterEach(() => {
  getContextWindowCaches().discoveredTokenCache.clear();
  persist.mockReset();
  authMocks.reset();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
});

const sessionKey = "agent:main:telegram:direct:1";
type SelectionOptions = Partial<Parameters<typeof createModelSelectionState>[0]>;
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function selectionConfig(
  defaults: Defaults,
  providers?: NonNullable<OpenClawConfig["models"]>["providers"],
): OpenClawConfig {
  return { agents: { defaults }, ...(providers ? { models: { providers } } : {}) };
}

function preparedCatalog(entries: ModelCatalogSnapshot["entries"]): ModelCatalogSnapshot {
  return { entries, routeVariants: [] };
}

function configuredProvider(letter: string) {
  return {
    api: "openai-responses" as const,
    baseUrl: `https://provider-${letter}.example/v1`,
    models: [
      makeConfiguredModel({ id: `model-${letter}1`, name: `Provider ${letter.toUpperCase()}` }),
    ],
  };
}

function expectUnset<T>(value: T, ...keys: (keyof T)[]) {
  for (const key of keys) {
    expect(value[key], String(key)).toBeUndefined();
  }
}

const userPin = (
  providerOverride: string,
  modelOverride: string,
  overrides: Partial<SessionEntry> = {},
) => makeEntry({ providerOverride, modelOverride, modelOverrideSource: "user", ...overrides });

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
  it("chooses the first allowed catalog row when the configured default is unavailable", async () => {
    const state = await createInitialState(
      selectionConfig({ model: "custom/blocked", modelPolicy: { allow: ["remote/*"] } }),
      "custom",
      "blocked",
      {
        preparedModelCatalog: preparedCatalog([
          { provider: "remote", id: "z-first", name: "First" },
          { provider: "remote", id: "a-second", name: "Second" },
        ]),
      },
    );
    expect(state).toMatchObject({ provider: "remote", model: "z-first" });
  });

  it.each(["observed thinking", "automatic-primary thinking"] as const)(
    "uses prepared %s metadata",
    async (kind) => {
      const automatic = kind === "automatic-primary thinking";
      const id = automatic ? "automatic" : "reasoner";
      const model = {
        provider: "fixture",
        id,
        name: id,
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: true,
        ...(automatic
          ? { compat: { supportedReasoningEfforts: ["xhigh"] } }
          : { thinkingLevelMap: { max: null } }),
      };
      const cfg = selectionConfig(
        {
          model: `fixture/${id}`,
          modelPolicy: automatic ? { allow: ["fixture/manual"] } : undefined,
        },
        automatic
          ? {
              fixture: {
                api: "openai-completions",
                baseUrl: "https://fixture.invalid/v1",
                models: [makeConfiguredModel({ id: "manual", name: "Manual", reasoning: false })],
              },
            }
          : undefined,
      );
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([
        automatic ? model : { ...model, thinkingLevelMap: { max: "max" } },
      ]);
      const state = await createInitialState(cfg, "fixture", id, {
        preparedModelCatalog: preparedCatalog([model]),
      });
      expect(
        isThinkingLevelSupported({
          provider: "fixture",
          model: id,
          level: automatic ? "xhigh" : "max",
          catalog: await state.resolveThinkingCatalog(),
        }),
      ).toBe(true);
      if (automatic) {
        expect(state.modelPolicy.allows({ provider: "fixture", model: id })).toBe(false);
        await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
      }
    },
  );

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
      cfg: selectionConfig({ models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } }),
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
  });

  it("keeps prepared thinking ownership", async () => {
    const provider = "fixture-provider";
    const model = "fixture-model";
    const preparedModelCatalog = preparedCatalog([
      { provider, id: model, name: "Fixture", reasoning: true },
    ]);
    prepareModelCatalogThinkingPolicies({
      catalog: preparedModelCatalog,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      pluginRegistry: {
        ...createEmptyPluginRegistry(),
        providers: [
          {
            pluginId: provider,
            source: "test",
            provider: {
              id: provider,
              label: provider,
              auth: [],
              resolveThinkingProfile: () => ({
                levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
                defaultLevel: "ultra",
              }),
            },
          },
        ],
      },
    });
    const ambient = vi
      .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
      .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
    try {
      const state = await createInitialState({}, provider, model, {
        hasModelDirective: true,
        preparedModelCatalog,
      });
      await expect(
        state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
      ).resolves.toBe("ultra");
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      ambient.mockRestore();
    }
  });
});

describe("session override precedence and persistence", () => {
  it.each([undefined, "rotate"])("handles concurrent repair state (%s)", async (origin) => {
    const rotating = origin === "rotate";
    const cfg = selectionConfig({
      model: { primary: "openai/gpt-4o" },
      models: rotating ? { "openai/gpt-4o": {} } : { "openai/gpt-4o": {}, "openai/gpt-5.5": {} },
    });
    const entry = makeEntry({
      ...(rotating ? { sessionId: "s1" } : {}),
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });
    const concurrentEntry = makeEntry({
      ...(rotating ? { sessionId: "s2" } : {}),
      updatedAt: entry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: rotating ? "gpt-4o" : "gpt-5.5",
      modelOverrideSource: "user",
    });
    persist.mockResolvedValueOnce(
      rotating
        ? {
            status: "lifecycle-invalidated",
            error: `Session "${sessionKey}" changed while starting work. Retry.`,
            entry: concurrentEntry,
          }
        : { status: "current", entry: concurrentEntry },
    );
    const sessionStore = { [sessionKey]: entry };
    const selection = selectSession(cfg, "openai", "gpt-4o", entry, {
      sessionStore,
      storePath: "sessions.json",
      model: "gpt-4o-mini",
    });
    if (rotating) {
      await expect(selection).rejects.toThrow(/changed while starting work/i);
    } else {
      const state = await selection;
      expect(state.modelPolicy.allows({ provider: "openai", model: "gpt-5.5" })).toBe(true);
      expect(state).toMatchObject({
        provider: "openai",
        model: "gpt-5.5",
        resetModelOverride: false,
      });
    }
    expect(entry).toMatchObject(
      rotating
        ? { sessionId: "s1", providerOverride: "openai", modelOverride: "gpt-4o-mini" }
        : {
            providerOverride: "openai",
            modelOverride: "gpt-5.5",
            modelOverrideSource: "user",
          },
    );
    if (rotating) {
      expect(sessionStore[sessionKey]).toBe(entry);
    } else {
      expect(sessionStore[sessionKey]).toEqual(entry);
    }
  });
});

describe("automatic fallback provenance", () => {
  const provider = "mac-studio";
  const model = "MiniMax-M2.7-MLX";
  const fallback = {
    providerOverride: "openrouter",
    modelOverride: "minimax/minimax-m2.7",
    modelOverrideSource: "auto" as const,
  };
  const fallbackOptions = {
    provider: "openrouter",
    model: fallback.modelOverride,
  };
  it.each([
    [
      "recovers source-less channel-primary provenance",
      {
        modelOverrideSource: undefined,
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o",
      },
      { primaryProvider: "openai", primaryModel: "gpt-4o" },
    ],
    [
      "recovers automatic fallback origin from notice",
      {
        fallbackNotice: {
          kind: "active" as const,
          selectedModel: `${provider}/${model}`,
          activeModel: "openrouter/minimax/minimax-m2.7",
        },
      },
      {},
    ],
  ] as const)("%s", async (_name, overrides, options) => {
    const entry = makeEntry({ ...fallback, ...overrides });
    const before = { ...entry };
    const state = await selectSession({}, provider, model, entry, {
      ...fallbackOptions,
      ...options,
    });
    expect(state).toMatchObject({
      provider: fallback.providerOverride,
      model: fallback.modelOverride,
      resetModelOverride: false,
    });
    expect(entry).toEqual(before);
  });

  it("clears a stale OpenAI pin and its ineligible auth", async () => {
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
    expectUnset(entry, "providerOverride", "modelOverride", "modelOverrideSource");
    expectUnset(entry, "modelProvider", "model", "contextTokens");
    expectUnset(entry, "authProfileOverride", "authProfileOverrideSource");
  });
});

it("keeps a missing explicit auth pin through credential restoration", async () => {
  authMocks.store = {
    version: 1,
    profiles: {
      "openai:account-a": { type: "api_key", provider: "openai", key: "test-key-a" },
    },
  };
  const entry = userPin("openai", "gpt-4o", {
    authProfileOverride: "openai:account-b",
    authProfileOverrideSource: "user",
  });
  const before = { ...entry };
  const sessionStore = { [sessionKey]: entry };
  const missing = await selectSession({}, "openai", "gpt-4o", entry, { sessionStore });
  expect(missing).toMatchObject({ provider: "openai", model: "gpt-4o" });
  expect(entry).toEqual(before);
  expect(sessionStore[sessionKey]).toBe(entry);

  authMocks.store.profiles["openai:account-b"] = {
    type: "api_key",
    provider: "openai",
    key: "test-key-b",
  };
  const restored = await selectSession({}, "openai", "gpt-4o", entry, { sessionStore });
  expect(restored).toMatchObject({ provider: "openai", model: "gpt-4o" });
  expect(entry).toEqual(before);
  expect(sessionStore[sessionKey]).toBe(entry);
});

it.each(["pin", "source", "provider", "session", "authority"] as const)(
  "rejects a changed %s after awaiting missing-pin provider facts",
  async (change) => {
    const cfg: OpenClawConfig = { agents: { defaults: { model: "openai/gpt-4o" } } };
    const entry = makeEntry({
      updatedAt: 1,
      authProfileOverride: "anthropic:missing",
      authProfileOverrideSource: "user",
    });
    const sessionStore = { [sessionKey]: entry };
    let current = true;
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { sourceAgent: "main" } }),
      assertCurrent: () => {
        if (!current) {
          throw new Error("authority revoked");
        }
      },
    });
    authMocks.prepareAuthProfileProvider.mockImplementationOnce(async () => {
      await Promise.resolve();
      if (change === "pin") {
        entry.authProfileOverride = "openai:replacement";
      }
      if (change === "source") {
        entry.authProfileOverrideSource = "auto";
      }
      if (change === "provider") {
        entry.providerOverride = "anthropic";
      }
      if (change === "session") {
        sessionStore[sessionKey] = { ...entry, sessionId: "replacement" };
      }
      if (change === "authority") {
        current = false;
      }
      return { provider: "anthropic" };
    });
    await expect(
      selectSession(cfg, "openai", "gpt-4o", entry, { sessionStore, operatorAuthority }),
    ).rejects.toThrow(
      change === "authority" ? "authority revoked" : "Session account selection changed",
    );
    expect(entry.authProfileOverride).toBe(
      change === "pin" ? "openai:replacement" : "anthropic:missing",
    );
    expect(entry.updatedAt).toBe(1);
  },
);

it("keeps a locked pin active without a degraded-catalog fallback notice", async () => {
  catalogMocks.loadModelCatalogSnapshot.mockResolvedValueOnce({
    entries: [],
    routeVariants: [],
    authoritative: false,
  });
  const cfg: OpenClawConfig = {
    agents: { defaults: { models: { "openai/gpt-4o-mini": {}, "anthropic/*": {} } } },
  };
  const entry = userPin("openai", "gpt-4o", { modelSelectionLocked: true });
  const state = await selectSession(cfg, "openai", "gpt-4o-mini", entry);
  expect(state.resetModelOverride).toBe(false);
  expectUnset(state, "resetModelOverrideReason", "resetModelOverrideRef");
  expect(state.model).toBe("gpt-4o");
  expect(entry.modelOverride).toBe("gpt-4o");
});

describe("refused pins use the primary instead of catalog order", () => {
  const cfg = selectionConfig(
    {
      model: "provider-b/model-b1",
      modelPolicy: { allow: ["provider-a/model-a1", "provider-b/model-b1"] },
    },
    {
      "provider-a": configuredProvider("a"),
      "provider-b": configuredProvider("b"),
    },
  );

  it.each(["direct", "parent", "degraded", "concurrent"] as const)(
    "uses the primary for a refused %s pin",
    async (source) => {
      const pin = userPin("provider-c", "model-c1");
      const entry = source === "parent" ? makeEntry() : { ...pin };
      const parentSessionKey = "agent:main:parent";
      const sessionStore = { [sessionKey]: entry, [parentSessionKey]: pin };
      if (source === "concurrent") {
        persist.mockResolvedValueOnce({
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
          storePath: source === "concurrent" ? "sessions.json" : undefined,
          preparedModelCatalog:
            source === "degraded"
              ? {
                  authoritative: false,
                  entries: [
                    { provider: "provider-a", id: "model-a1", name: "First" },
                    { provider: "provider-b", id: "model-b1", name: "Primary" },
                  ],
                  routeVariants: [],
                }
              : undefined,
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
        expectUnset(entry, "modelOverride", "providerOverride");
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
});

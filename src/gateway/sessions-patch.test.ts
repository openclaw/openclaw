// Session patch tests cover model/provider edits, subagent patching, provider
// aliases, model catalog validation, and rejected invalid patch payloads.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import * as auth from "../sessions/auth-profile-preservation.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { withAgentSessionModelPatchOrigin } from "./session-model-patch-origin.js";
import {
  type ApplySessionsPatchArgs,
  MAIN_SESSION_KEY,
  runPatchFields as runPatch,
  patchFieldsOk as patchOk,
  expectPatchOk,
  expectPatchError,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

const acpSessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionMetaForEntryAsync: vi.fn(),
}));
const providerThinkingMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile:
    vi.fn<typeof import("../plugins/provider-thinking.js").resolveEffectiveThinkingProfile>(),
}));

// mock-isolation: Patch projection fixtures provide ACP metadata without opening real session stores.
vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntryAsync: acpSessionMetaMocks.readAcpSessionMetaForEntryAsync,
}));

// This suite owns patch projection; provider policy artifacts have dedicated contract coverage.
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerThinkingMocks.resolveProviderThinkingProfile,
}));

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.7-Code";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const ANTHROPIC_SONNET_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_SONNET_ID = "claude-sonnet-4-6";
const ANTHROPIC_OPUS_MODEL = "anthropic/claude-opus-4-6";
const ANTHROPIC_OPUS_ID = "claude-opus-4-6";
const OPENAI_GPT_MODEL = "openai/gpt-5.4";
const OPENAI_GPT_ID = "gpt-5.4";

const applyAuthOverride = auth.applyModelOverrideWithAuthProfileCompatibility;
type ProviderAuthMetadataSnapshot = NonNullable<
  Parameters<typeof applyAuthOverride>[0]["metadataSnapshot"]
>;

const EMPTY_PROVIDER_AUTH_METADATA_SNAPSHOT = {
  plugins: [],
} satisfies ProviderAuthMetadataSnapshot;
const BYTEPLUS_PROVIDER_AUTH_METADATA_SNAPSHOT = {
  plugins: [
    {
      id: "byteplus",
      channels: [],
      providers: ["byteplus", "byteplus-plan"],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/plugins/byteplus",
      source: "test",
      manifestPath: "/plugins/byteplus/openclaw.plugin.json",
      providerAuthAliases: { "byteplus-plan": "byteplus" },
    } satisfies PluginManifestRecord,
  ],
} satisfies ProviderAuthMetadataSnapshot;

type ModelDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function agentConfig(
  defaults: ModelDefaults | undefined,
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { agents: { ...(defaults ? { defaults } : {}), ...(entries ? { entries } : {}) } };
}
function modelConfig(primary: string, defaults: ModelDefaults = {}): OpenClawConfig {
  return agentConfig({ model: { primary }, ...defaults });
}

function mainAuthOverrideStore(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return mainStoreEntry({
    providerOverride: "anthropic",
    modelOverride: ANTHROPIC_OPUS_ID,
    authProfileOverrideSource: "user",
    ...overrides,
  });
}

function catalogEntry(ref: string, metadata: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  const separator = ref.indexOf("/");
  if (separator < 0) {
    throw new Error(`model ref must include provider: ${ref}`);
  }
  const id = ref.slice(separator + 1);
  return {
    provider: ref.slice(0, separator),
    id,
    name: id,
    ...metadata,
  };
}

function loadCatalog(...refs: string[]): ApplySessionsPatchArgs["loadGatewayModelCatalog"] {
  return async () => refs.map((ref) => catalogEntry(ref));
}

function expectModelSelection(
  entry: SessionEntry,
  providerOverride: string | undefined,
  modelOverride: string | undefined,
) {
  expect([entry.providerOverride, entry.modelOverride]).toEqual([providerOverride, modelOverride]);
}

async function applyMainModelPatch(params: {
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  model: string | null;
  catalogRefs?: string[];
  providerAuthMetadataSnapshot?: ProviderAuthMetadataSnapshot;
}) {
  const metadataSnapshot =
    params.providerAuthMetadataSnapshot ?? EMPTY_PROVIDER_AUTH_METADATA_SNAPSHOT;
  using _ = vi
    .spyOn(auth, "applyModelOverrideWithAuthProfileCompatibility")
    .mockImplementation((options) => applyAuthOverride({ ...options, metadataSnapshot }));
  return await patchOk({
    store: params.store,
    cfg: params.cfg,
    model: params.model,
    loadGatewayModelCatalog:
      params.catalogRefs === undefined ? undefined : loadCatalog(...params.catalogRefs),
  });
}

function expectAuthOverride(
  entry: SessionEntry,
  expected: {
    profile: string | undefined;
    source?: string;
    compactionCount?: number;
  },
) {
  expect([
    entry.authProfileOverride,
    entry.authProfileOverrideSource,
    entry.authProfileOverrideCompactionCount,
  ]).toEqual([
    expected.profile,
    expected.profile === undefined ? undefined : (expected.source ?? "user"),
    expected.profile === undefined ? undefined : expected.compactionCount,
  ]);
}

async function applySubagentModelPatch(cfg: OpenClawConfig, store: Record<string, SessionEntry>) {
  return runPatch({
    cfg,
    store,
    storeKey: KIMI_SUBAGENT_KEY,
    model: SUBAGENT_MODEL,
    loadGatewayModelCatalog: async () => [
      { provider: "anthropic", id: ANTHROPIC_SONNET_ID, name: "sonnet" },
      { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.7-Code", name: "kimi" },
    ],
  });
}

function makeKimiSubagentCfg(params: {
  allowModel: boolean;
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return agentConfig(
    {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      modelPolicy: { allow: [ANTHROPIC_SONNET_MODEL] },
      subagents: params.defaultsSubagentModel ? { model: params.defaultsSubagentModel } : undefined,
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "default" },
      },
    },
    {
      kimi: {
        ...(params.allowModel ? { modelPolicy: { allow: [SUBAGENT_MODEL] } } : {}),
        model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
        subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
      },
    },
  );
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return modelConfig(OPENAI_GPT_MODEL, {
    models: {
      [ANTHROPIC_SONNET_MODEL]: { alias: "sonnet" },
    },
  });
}

describe("gateway sessions patch", () => {
  beforeAll(async () => {
    await prepareSharedAuthStoreOwnership();
  });

  beforeEach(() => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockReset();
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) => {
        if (provider !== "openai") {
          return undefined;
        }
        const base = ["off", "minimal", "low", "medium", "high"] as const;
        const levels =
          context.modelId === "gpt-5.5"
            ? ([...base, "xhigh"] as const)
            : context.modelId === "gpt-5.6-luna"
              ? context.agentRuntime === "openclaw"
                ? ([...base, "max", "ultra"] as const)
                : ([...base, "max"] as const)
              : undefined;
        return levels && { levels: levels.map((id) => ({ id })) };
      },
    );
  });

  afterEach(() => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockReset();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  const anthropicSelection = {
    model: ANTHROPIC_SONNET_MODEL,
    provider: "anthropic",
    modelId: ANTHROPIC_SONNET_ID,
  };

  test.each([
    {
      name: "provider auth alias",
      overrides: {
        providerOverride: "byteplus",
        modelOverride: "seedance-1-0-lite-t2v-250428",
        authProfileOverride: "byteplus:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      },
      model: "byteplus-plan/ark-code-latest",
      provider: "byteplus-plan",
      modelId: "ark-code-latest",
      providerAuthMetadataSnapshot: BYTEPLUS_PROVIDER_AUTH_METADATA_SNAPSHOT,
      expected: { profile: "byteplus:work", compactionCount: 2 },
    },
    {
      name: "unprefixed default provider",
      overrides: {
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 4,
        providerOverride: undefined,
        modelOverride: undefined,
      },
      cfg: modelConfig(`anthropic/${ANTHROPIC_OPUS_ID}`) satisfies OpenClawConfig,
      ...anthropicSelection,
      expected: { profile: "work", compactionCount: 4 },
    },
    {
      name: "unprefixed provider change",
      overrides: {
        authProfileOverride: "work",
        authProfileOverrideCompactionCount: 4,
      },
      model: OPENAI_GPT_MODEL,
      provider: "openai",
      modelId: OPENAI_GPT_ID,
      expected: { profile: undefined },
    },
  ] satisfies {
    name: string;
    overrides: Partial<SessionEntry>;
    model: string;
    provider: string;
    modelId: string;
    expected: Parameters<typeof expectAuthOverride>[1];
    cfg?: OpenClawConfig;
    providerAuthMetadataSnapshot?: ProviderAuthMetadataSnapshot;
  }[])("preserves only compatible auth overrides: $name", async (scenario) => {
    const entry = await applyMainModelPatch({
      ...scenario,
      store: mainAuthOverrideStore(scenario.overrides),
      catalogRefs: [scenario.model],
    });
    expectModelSelection(entry, scenario.provider, scenario.modelId);
    expectAuthOverride(entry, scenario.expected);
  });

  test.each([
    { name: "change", model: ANTHROPIC_SONNET_MODEL },
    { name: "reset", model: null },
  ])("rejects locked model $name patches before catalog loading", async ({ model }) => {
    const store = mainStoreEntry({
      sessionId: "sess-model-locked",
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelSelectionLocked: true,
    });
    const before = { ...store[MAIN_SESSION_KEY] };
    const loadGatewayModelCatalog = vi.fn(loadCatalog(ANTHROPIC_SONNET_MODEL));

    const result = await runPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model,
      loadGatewayModelCatalog,
    });

    expectPatchError(result, MODEL_SELECTION_LOCKED_MESSAGE);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(store[MAIN_SESSION_KEY]).toEqual(before);
  });

  test.each(["fresh", "placeholder", "existing"] as const)(
    "queues model switches only for existing sessions (%s)",
    async (sessionState) => {
      const store =
        sessionState === "fresh"
          ? undefined
          : mainStoreEntry({
              sessionId: sessionState === "existing" ? "sess-live" : undefined,
              providerOverride: "openai",
              modelOverride: OPENAI_GPT_ID,
              modelFallback: {
                prevModel: OPENAI_GPT_ID,
                prevProvider: "openai",
                ts: 1,
                source: "agent-patch",
              },
            });
      const entry = await applyMainModelPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        model: ANTHROPIC_SONNET_MODEL,
        catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
      });

      expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
      expect(entry.liveModelSwitchPending).toBe(sessionState === "existing" ? true : undefined);
      expect(entry.modelFallback).toBeUndefined();
    },
  );

  test("snapshots prior selection atomically and retains it across consecutive agent patches", async () => {
    const cfg = createAllowlistedAnthropicModelCfg();
    cfg.agents!.defaults!.models![ANTHROPIC_OPUS_MODEL] = { alias: "opus" };
    const store = mainStoreEntry({
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-primary",
      authProfileOverride: "openai:good",
      authProfileOverrideSource: "user",
      thinkingLevel: "high",
    });
    const entry = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store,
          cfg,
          model: ANTHROPIC_SONNET_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
        }),
    );

    expect(entry.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
      prevModelOverrideSource: "auto",
      prevModelOverrideFallbackOriginProvider: "openai",
      prevModelOverrideFallbackOriginModel: "gpt-primary",
      prevAuthProfileOverride: "openai:good",
      prevThinkingLevel: "high",
      source: "agent-patch",
    });
    const firstMarker = entry.modelFallback;

    const second = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store: { [MAIN_SESSION_KEY]: entry },
          cfg,
          model: ANTHROPIC_OPUS_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL, ANTHROPIC_OPUS_MODEL],
        }),
    );

    expect(second.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
    });
    expect(second.modelFallback?.ts).toBeGreaterThan(firstMarker?.ts ?? 0);
  });

  test.each([
    { patch: { thinkingLevel: "low" }, thinking: "low", context: "extended" },
    { patch: { contextWindow: null }, thinking: "high", context: undefined },
    {
      patch: { contextWindow: null, thinkingLevel: null },
      thinking: undefined,
      context: undefined,
    },
  ] as const)(
    "realigns rollback metadata without mutating its input: $patch",
    async ({ patch, thinking, context }) => {
      const store = mainStoreEntry({
        modelOverride: ANTHROPIC_SONNET_ID,
        providerOverride: "anthropic",
        thinkingLevel: "high",
        contextWindow: "extended",
        modelFallback: {
          prevModel: OPENAI_GPT_ID,
          prevProvider: "openai",
          prevThinkingLevel: "high",
          prevContextWindow: "extended",
          ts: 1,
          source: "agent-patch",
        },
      });
      const input = Object.freeze(store[MAIN_SESSION_KEY]!);
      const before = structuredClone(input);
      const entry = await patchOk({ store, ...patch });
      expect(entry.thinkingLevel).toBe(thinking);
      expect(entry.contextWindow).toBe(context);
      expect(entry.modelFallback).toMatchObject({
        prevModel: OPENAI_GPT_ID,
        prevProvider: "openai",
        prevThinkingLevel: thinking,
        prevContextWindow: context,
        ts: 1,
        source: "agent-patch",
      });
      expect(input).toEqual(before);
    },
  );

  test("clears pending live model switches for model reset patches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-live-reset",
      providerOverride: "anthropic",
      modelOverride: ANTHROPIC_SONNET_ID,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    const loadGatewayModelCatalog = vi.fn(async () => {
      throw new Error("Catalog must not be needed for an unqualified reset");
    });
    const entry = await patchOk({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: null,
      loadGatewayModelCatalog,
    });

    expectModelSelection(entry, undefined, undefined);
    expect(entry.modelOverrideSource).toBe("default");
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "model reset revalidates retained selections once (context supported: %s)",
    async (supported) => {
      const loadGatewayModelCatalog = vi.fn(async () => [
        {
          ...catalogEntry(ANTHROPIC_SONNET_MODEL),
          reasoning: true,
          contextWindows: supported
            ? [{ id: "extended", label: "Extended", contextWindow: 200_000 }]
            : [],
        },
      ]);
      const entry = await patchOk({
        cfg: agentConfig({ model: ANTHROPIC_SONNET_MODEL }),
        mainEntry: {
          providerOverride: "anthropic",
          modelOverride: ANTHROPIC_OPUS_ID,
          thinkingLevel: "high",
          contextWindow: "extended",
        },
        model: null,
        loadGatewayModelCatalog,
      });
      expectModelSelection(entry, undefined, undefined);
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.contextWindow).toBe(supported ? "extended" : undefined);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    },
  );

  test("one catalog prepares a combined model, thinking, and context-window patch", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      {
        ...catalogEntry(ANTHROPIC_SONNET_MODEL),
        reasoning: true,
        contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
      },
    ]);
    const entry = await patchOk({
      cfg: createAllowlistedAnthropicModelCfg(),
      mainEntry: {},
      model: ANTHROPIC_SONNET_MODEL,
      thinkingLevel: "high",
      contextWindow: "extended",
      loadGatewayModelCatalog,
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expect(entry).toMatchObject({ thinkingLevel: "high", contextWindow: "extended" });
    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
  });

  test.each([
    { patch: { category: "" }, message: "invalid category" },
    { patch: { model: "" }, message: "invalid model: empty" },
  ])(
    "preserves early validation before catalog preparation: $message",
    async ({ patch, message }) => {
      const loadGatewayModelCatalog = vi.fn(async () => {
        throw new Error("Catalog failure must not replace early validation");
      });
      const store = mainStoreEntry({ label: "Original" });
      expectPatchError(
        await runPatch({ store, contextWindow: "extended", ...patch, loadGatewayModelCatalog }),
        message,
      );
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
      expect(store[MAIN_SESSION_KEY]).toEqual({
        sessionId: "sess",
        updatedAt: 1,
        label: "Original",
      });
    },
  );

  test.each([
    { name: "explicit allowlist", agentPolicy: undefined },
    { name: "unrestricted default policy", agentPolicy: false },
    { name: "unrestricted agent policy", agentPolicy: true },
  ])("accepts uncataloged refs: $name", async ({ agentPolicy }) => {
    const explicitAllowlist = agentPolicy === undefined;
    const cfg = explicitAllowlist
      ? createAllowlistedAnthropicModelCfg()
      : (agentConfig(
          {
            model: { primary: "synthetic/primary" },
            modelPolicy: { allow: agentPolicy ? ["synthetic/primary"] : [] },
          },
          { main: agentPolicy ? { modelPolicy: { allow: [] } } : {} },
        ) satisfies OpenClawConfig);
    const key = explicitAllowlist ? MAIN_SESSION_KEY : "global";
    const entry = await patchOk({
      cfg,
      storeKey: key,
      model: explicitAllowlist ? ANTHROPIC_SONNET_MODEL : "synthetic/uncataloged",
      loadGatewayModelCatalog: loadCatalog(...(explicitAllowlist ? [OPENAI_GPT_MODEL] : [])),
    });
    expectModelSelection(
      entry,
      explicitAllowlist ? "anthropic" : "synthetic",
      explicitAllowlist ? ANTHROPIC_SONNET_ID : "uncataloged",
    );
    expect(entry.modelOverrideSource).toBe("user");
  });

  test("enforces the default agent policy without an explicit agent or qualified key", async () => {
    const key = "global";
    const existing: SessionEntry = { sessionId: "default-policy", updatedAt: 1, label: "Original" };
    const store = { [key]: existing };
    const result = await runPatch({
      cfg: agentConfig(
        { model: "synthetic/primary", modelPolicy: { allow: [] } },
        { main: { modelPolicy: { allow: ["synthetic/allowed"] } } },
      ),
      store,
      storeKey: key,
      model: "synthetic/outside",
      label: "Changed",
      loadGatewayModelCatalog: loadCatalog("synthetic/allowed", "synthetic/outside"),
    });

    expectPatchError(result, "model not allowed: synthetic/outside");
    expect(store[key]).toEqual(existing);
  });

  test.each(["fresh", "placeholder", "existing"] as const)(
    "validates context-window initialization without queuing fresh-session switches (%s)",
    async (sessionState) => {
      const cfg = modelConfig("claude-cli/claude-fable-5");
      const loadGatewayModelCatalog = async () => [
        catalogEntry("claude-cli/claude-fable-5", {
          name: "Claude Fable 5",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        }),
      ];

      const entry = await patchOk({
        cfg,
        store:
          sessionState === "fresh"
            ? undefined
            : mainStoreEntry({
                sessionId: sessionState === "existing" ? "sess-context" : undefined,
                contextBudgetStatus: contextBudgetStatusFixture(),
              }),
        contextWindow: "200k",
        loadGatewayModelCatalog,
      });
      expect(entry.contextWindow).toBe("200k");
      expect(entry.contextBudgetStatus).toBeUndefined();
      expect(entry.liveModelSwitchPending).toBe(sessionState === "existing" ? true : undefined);

      const invalid = await runPatch({ cfg, contextWindow: "2m", loadGatewayModelCatalog });
      expectPatchError(invalid, 'contextWindow "2m" is not supported');
    },
  );

  test("rejects thinking levels forbidden by the concrete runtime policy", async () => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "claude-cli"
        ? { levels: [{ id: "off" }], defaultLevel: "off" }
        : {
            levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
            defaultLevel: "adaptive",
            preserveWhenCatalogReasoningFalse: true,
          },
    );

    const result = await runPatch({
      cfg: modelConfig("anthropic/claude-mythos-5"),
      thinkingLevel: "medium",
      loadGatewayModelCatalog: async () => [
        catalogEntry("anthropic/claude-mythos-5", {
          name: "Claude Mythos 5",
          reasoning: false,
          thinkingPolicyProvider: "claude-cli",
        }),
      ],
    });

    expectPatchError(result, 'thinkingLevel "medium" is not supported');
  });

  test("validates global patches against the selected agent", async () => {
    const entry = await patchOk({
      cfg: agentConfig(undefined, {
        main: {
          model: { primary: "gmn/gpt-5.4" },
        },
        work: {
          model: { primary: "openai/gpt-5.5" },
        },
      }) as OpenClawConfig,
      storeKey: "global",
      agentId: "work",
      thinkingLevel: "xhigh",
      loadGatewayModelCatalog: async () => [],
    });

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test.each(["configured", "session"] as const)(
    "validates Ultra with the %s runtime override",
    async (source) => {
      const entry = await patchOk({
        cfg: modelConfig("openai/gpt-5.6-luna", {
          models:
            source === "configured"
              ? {
                  "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
                }
              : undefined,
        }),
        store:
          source === "session"
            ? mainStoreEntry({
                agentRuntimeOverride: "openclaw",
                agentHarnessId: "codex",
              })
            : undefined,
        thinkingLevel: "ultra",
        loadGatewayModelCatalog: async () => [],
      });

      expect(entry.thinkingLevel).toBe("ultra");
    },
  );

  test("preserves stored Ultra when a model patch selects Codex Luna", async () => {
    const entry = await patchOk({
      cfg: modelConfig("openai/gpt-5.6-sol", {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
        },
      }),
      mainEntry: { thinkingLevel: "ultra" },
      model: "openai/gpt-5.6-luna",
      loadGatewayModelCatalog: loadCatalog("openai/gpt-5.6-sol", "openai/gpt-5.6-luna"),
    });

    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("clearing a runtime pin preserves supported thinking and invalidates derived context", async () => {
    const entry = await patchOk({
      cfg: agentConfig({ model: "openai/gpt-5.6-luna" }),
      mainEntry: {
        agentRuntimeOverride: "openclaw",
        thinkingLevel: "ultra",
        contextTokens: 1000,
      },
      agentRuntime: null,
      loadGatewayModelCatalog: loadCatalog("openai/gpt-5.6-luna"),
    });
    expect(entry).toMatchObject({ thinkingLevel: "ultra", liveModelSwitchPending: true });
    expect(entry).not.toHaveProperty("agentRuntimeOverride");
    expect(entry).not.toHaveProperty("contextTokens");
  });

  test.each([null, "openclaw"])(
    "retains locked model and runtime ownership (%s)",
    async (agentRuntime) => {
      const store = mainStoreEntry({ modelSelectionLocked: true, agentRuntimeOverride: "codex" });
      expectPatchError(
        await runPatch({
          store,
          agentRuntime,
          ...(agentRuntime ? { model: "openai/gpt-5.6-sol" } : {}),
        }),
        MODEL_SELECTION_LOCKED_MESSAGE,
      );
      expect(store[MAIN_SESSION_KEY]?.agentRuntimeOverride).toBe("codex");
    },
  );

  test("does not persist a misleading runtime pin on an ACP-owned session", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockResolvedValue({
      backend: "codex",
      agent: "main",
      state: "idle",
    });
    expectPatchError(
      await runPatch({ mainEntry: {}, agentRuntime: null }),
      "owned by this ACP session",
    );
  });

  test("uses ACP backend metadata on canonical agent keys for thinking validation", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockResolvedValue({
      backend: "codex",
      agent: "main",
      runtimeSessionName: MAIN_SESSION_KEY,
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    });

    const result = await runPatch({
      cfg: modelConfig("openai/gpt-5.6-luna", {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
        },
      }),
      mainEntry: {},
      thinkingLevel: "xhigh",
      loadGatewayModelCatalog: async () => [],
    });

    expectPatchError(result, 'thinkingLevel "xhigh" is not supported');
    expect(acpSessionMetaMocks.readAcpSessionMetaForEntryAsync).toHaveBeenCalledWith({
      sessionKey: MAIN_SESSION_KEY,
      agentId: "main",
      entry: expect.objectContaining({ sessionId: "sess" }),
    });
  });

  test("preserves an incompatible stored thinkingLevel without loading the catalog for unrelated patches", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      catalogEntry("synthetic/plain", { reasoning: false }),
    ]);
    const entry = await patchOk({
      cfg: modelConfig("synthetic/plain"),
      mainEntry: { thinkingLevel: "max" },
      label: "new label",
      loadGatewayModelCatalog,
    });

    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ label: "new label", thinkingLevel: "max" });
  });

  test.each(
    [
      { source: "target agent primary", agentPrimaryModel: SUBAGENT_MODEL },
      {
        source: "target agent subagents.model",
        agentPrimaryModel: ANTHROPIC_SONNET_MODEL,
        agentSubagentModel: SUBAGENT_MODEL,
      },
      { source: "global subagents.model", defaultsSubagentModel: SUBAGENT_MODEL },
    ].flatMap((config) => [
      { ...config, allowModel: false },
      { ...config, allowModel: true },
    ]),
  )("requires manual permission for $source (allowed: $allowModel)", async (config) => {
    const cfg = makeKimiSubagentCfg(config);
    const store: Record<string, SessionEntry> = {
      [KIMI_SUBAGENT_KEY]: {
        sessionId: "subagent-policy",
        updatedAt: 1,
        delivery: { kind: "none" },
      },
    };
    const before = structuredClone(store);
    const result = await applySubagentModelPatch(cfg, store);
    if (!config.allowModel) {
      expectPatchError(result, "model not allowed");
      expect(store).toEqual(before);
      return;
    }
    const entry = expectPatchOk(result);
    if (config.agentPrimaryModel === SUBAGENT_MODEL) {
      expectModelSelection(entry, undefined, undefined);
      expect(entry.modelOverrideSource).toBe("default");
      expect(entry.modelOverrideRouteResolution).toBeUndefined();
    } else {
      expectModelSelection(entry, "synthetic", "hf:moonshotai/Kimi-K2.7-Code");
      expect(entry.modelOverrideSource).toBe("user");
    }
  });

  test.each([
    { profile: "newprofile", existing: true },
    { profile: "openai:user@example.com", existing: false },
  ])("persists @profile=$profile (existing=$existing)", async ({ profile, existing }) => {
    const store = existing
      ? mainStoreEntry({
          sessionId: "sess-live-profile-only",
          providerOverride: "anthropic",
          modelOverride: ANTHROPIC_SONNET_ID,
          authProfileOverride: "oldprofile",
          authProfileOverrideSource: "user",
        })
      : undefined;
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: `${ANTHROPIC_SONNET_MODEL}@${profile}`,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile });
    if (existing) {
      expect(entry.liveModelSwitchPending).toBe(true);
    }
  });

  test("resolves bare allowlisted model ids before persisting @profile suffix", async () => {
    const entry = await patchOk({
      cfg: modelConfig("openai/gpt-5.4", {
        models: {
          "opencode-go/kimi-k2.6": {},
        },
      }),
      model: "kimi-k2.6@work",
      loadGatewayModelCatalog: loadCatalog(OPENAI_GPT_MODEL, "opencode-go/kimi-k2.6"),
    });
    expect(entry.providerOverride).toBe("opencode-go");
    expect(entry.modelOverride).toBe("kimi-k2.6");
    expect(entry.authProfileOverride).toBe("work");
  });
});

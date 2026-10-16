import { beforeEach, expect, it, vi } from "vitest";
import { resolveContextTokensForModelFromCache } from "../agents/context-resolution.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  clearActiveCredentialDegradedOwner,
  setActiveCredentialDegradedOwner,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { getStatusSummary } from "../status/summary.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  registerStatusSummarySessionRowCases,
  registerStatusSummaryWalCases,
} from "./status.summary.test-support.js";

type SessionFixture = { sessionKey: string; entry: Record<string, unknown> };
const modelRef = vi.hoisted(() => (provider = "openai", model = "gpt-5.5") => ({
  provider,
  model,
}));
const mocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScopeAsync: vi.fn<
    typeof import("../plugins/channel-plugin-ids.js").hasConfiguredChannelsForReadOnlyScopeAsync
  >(async () => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  resolveProviderStaticModel: vi.fn(),
  getPreparedModelCatalogSnapshot:
    vi.fn<typeof import("../agents/prepared-model-catalog.js").getPreparedModelCatalogSnapshot>(),
  listSessionEntriesCore: vi.fn<
    (scope?: { agentId?: string; storePath?: string }) => SessionFixture[]
  >(() => []),
  withSessionEntriesFromStoresInWorker:
    vi.fn<
      typeof import("../config/sessions/session-entry-read-runtime.js").withSessionEntriesFromStoresInWorker
    >(),
}));
// mock-isolation: Keep plugin discovery outside this status aggregation fixture.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScopeAsync: mocks.hasConfiguredChannelsForReadOnlyScopeAsync,
}));
// mock-isolation: Exercise catalog projection without preparing runtime owners or provider I/O.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  getPreparedModelCatalogSnapshot: mocks.getPreparedModelCatalogSnapshot,
}));
vi.mock("../status/summary.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../status/summary.runtime.js")>();
  return {
    ...actual,
    statusSummaryRuntime: {
      ...actual.statusSummaryRuntime,
      resolveConfiguredStatusModelRef: vi.fn(() => modelRef()),
      resolveSessionModelRef: vi.fn(() => modelRef()),
      resolveSessionRuntime: vi.fn(() => ({ id: "openclaw", label: "OpenClaw Default" })),
      readSessionRuntimeMetadata: vi.fn(async (_cfg, candidates) => candidates.map(() => null)),
      resolveStatusModelLookupRef: vi.fn(actual.statusSummaryRuntime.resolveStatusModelLookupRef),
      resolveStatusModelComparisonLabel: vi.fn(
        actual.statusSummaryRuntime.resolveStatusModelComparisonLabel,
      ),
      resolveAuthoredModelContextTokens: vi.fn(() => undefined),
      resolveContextTokensForModel: vi.fn(() => 200_000),
    },
  };
});
vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.5",
  DEFAULT_PROVIDER: "openai",
}));
vi.mock("../agents/embedded-agent-runner/model.static-catalog.js", () => ({
  createBundledStaticCatalogModelResolver: vi.fn(() =>
    vi.fn(({ provider, modelId }) =>
      provider === "openai" && modelId === "gpt-5.5"
        ? { contextWindow: 1_000_000, contextTokens: 272_000 }
        : undefined,
    ),
  ),
  createBundledProviderStaticCatalogContextResolver: vi.fn(() => mocks.resolveProviderStaticModel),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  captureRuntimeConfigAsyncReader: vi.fn(() =>
    Object.assign(async () => ({}), { assertCurrent() {} }),
  ),
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
}));
// mock-isolation: Status aggregation consumes fixture summaries and counts without starting session storage.
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { createSessionStoreSummaryReaderStub } =
    await import("../config/sessions/session-store-summary.test-support.js");
  return {
    withSessionEntriesFromStoresInWorker: mocks.withSessionEntriesFromStoresInWorker,
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub((scope, options) => {
      const entries = mocks
        .listSessionEntriesCore(scope)
        .filter(({ sessionKey }) => sessionKey.startsWith("agent:"))
        .map(normalizeEntry)
        .toSorted(
          (left, right) =>
            right.entry.updatedAt - left.entry.updatedAt ||
            (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0),
        );
      const summarize = (rows: typeof entries) => ({
        count: rows.length,
        recent: rows.slice(0, options.recentLimit),
      });
      return {
        ...summarize(entries),
        byAgent: new Map(
          options.agentIds.map((agentId) => [
            agentId,
            summarize(
              entries.filter(({ sessionKey }) => sessionKey.startsWith(`agent:${agentId}:`)),
            ),
          ]),
        ),
      };
    }),
  };
});
vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: vi.fn(),
}));
vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: mocks.buildChannelSummary,
}));
vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: vi.fn(() => []),
}));
vi.mock("../status/link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

const { buildChannelSummary } = await import("../infra/channel-summary.js");
const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
const { peekSystemEvents } = await import("../infra/system-events.js");
const { resolveLinkChannelContext } = await import("../status/link-channel.js");
const { statusSummaryRuntime: runtime } = await import("../status/summary.runtime.js");

function normalizeEntry({ sessionKey, entry }: SessionFixture) {
  return { sessionKey, entry: { sessionId: sessionKey, updatedAt: 0, ...entry } };
}

function setAgents(
  ids = ["main"],
  scope: "global" | "per-sender" = "per-sender",
  mainKey = "main",
) {
  vi.mocked(listGatewayAgentsBasic).mockResolvedValue({
    defaultId: ids[0]!,
    mainKey,
    scope,
    agents: ids.map((id) => ({ id })),
    ownership: ids.length > 1 ? "explicit" : "sole",
    selectionRequired: ids.length > 1,
  });
}
const routeEntry = () => ({
  delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "123" } }),
});
function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}
function setSession(entry: Record<string, unknown>) {
  mocks.listSessionEntriesCore.mockReturnValue([
    { sessionKey: "agent:main:main", entry: { sessionId: "session-1", updatedAt: 100, ...entry } },
  ]);
}

function globalSummary(
  heartbeat: { every: string; target?: "last"; agentId?: string },
  mainKey?: string,
) {
  return getStatusSummary({
    config: {
      agents: {
        ownership: "explicit",
        entries: { research: {}, ops: {} },
        defaults: { heartbeat },
      },
      session: { scope: "global", mainKey },
    },
    includeSensitive: false,
    includeChannelSummary: false,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setActiveDegradedPlugins([]);
  clearActiveCredentialDegradedOwner("account", "telegram:work");
  setActiveDegradedSecretOwners([]);
  mocks.withSessionEntriesFromStoresInWorker.mockImplementation(async (inputs, consume) =>
    consume(
      inputs.map((input) => ({
        database: { agentId: input.agentId, path: input.storePath, env: {} },
        assertCurrent: () => {},
        result: {
          kind: "session-exact-entries",
          lifecycleTimestamps: {},
          entries: mocks
            .listSessionEntriesCore(input)
            .filter(({ sessionKey }) => input.sessionKeys?.includes(sessionKey))
            .map(normalizeEntry),
        },
      })),
    ),
  );
  setAgents();
});

registerStatusSummarySessionRowCases({
  getStatusSummary,
  getStatusSummaryRuntime: () => runtime,
  rejectProviderStaticModel: (error) =>
    mocks.resolveProviderStaticModel.mockRejectedValueOnce(error),
  setSessions: (store) =>
    mocks.listSessionEntriesCore.mockReturnValue(toSessionEntrySummaries(store)),
});
registerStatusSummaryWalCases(getStatusSummary);

it("summarizes every configured agent's global pending events without an ambient owner", async () => {
  setAgents(["research", "ops"], "global", "inbox");
  vi.mocked(peekSystemEvents).mockImplementation((key) => [`pending: ${key}`]);
  const summary = await globalSummary({ agentId: "ops", every: "0m" }, "inbox");
  expect(summary.sessions.byAgent.map((agent) => agent.agentId)).toEqual(["research", "ops"]);
  expect(summary.queuedSystemEvents).toEqual([
    "pending: agent:research:global",
    "pending: agent:ops:global",
  ]);
});

it.each([false, true])("reads the configured heartbeat route (empty=%s)", async (empty) => {
  const main = "agent:main:main";
  const configured = "agent:main:telegram:alerts";
  mocks.listSessionEntriesCore.mockReturnValue([
    {
      sessionKey: empty ? main : configured,
      entry: routeEntry(),
    },
    { sessionKey: empty ? configured : main, entry: {} },
  ]);
  const summary = await getStatusSummary({
    config: {
      agents: { defaults: { heartbeat: { target: "last", session: "telegram:alerts" } } },
    },
  });
  expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(empty);
});

it("keeps global heartbeat routes separate across agent stores", async () => {
  vi.mocked(resolveSessionStorePathCore).mockImplementation(
    (_store, options) => `/tmp/${options?.agentId}/sessions.json`,
  );
  setAgents(["research", "ops"], "global");
  mocks.listSessionEntriesCore.mockImplementation((scope) => [
    {
      sessionKey: "global",
      entry: scope?.agentId === "research" ? routeEntry() : {},
    },
  ]);
  const summary = await globalSummary({ target: "last", every: "30m" });
  expect(summary.heartbeat.agents).toMatchObject([
    { agentId: "research", waitingForRoute: false },
    { agentId: "ops", waitingForRoute: true },
  ]);
});

it("does not read an unused route for a disabled heartbeat", async () => {
  const summary = await getStatusSummary({
    config: { agents: { defaults: { heartbeat: { target: "owner", every: "0m" } } } },
    includeChannelSummary: false,
  });
  expect(summary.heartbeat.agents[0]).toMatchObject({ enabled: false, waitingForRoute: false });
  expect(mocks.withSessionEntriesFromStoresInWorker).not.toHaveBeenCalled();
});

it("skips session model discovery and projection when sensitive output is disabled", async () => {
  setSession({ model: "gpt-5.5", modelProvider: "openai", totalTokens: 42 });
  const summary = await getStatusSummary({ includeSensitive: false });
  expect(mocks.getPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
  expect(runtime.resolveConfiguredStatusModelRef).not.toHaveBeenCalled();
  expect(runtime.resolveSessionRuntime).not.toHaveBeenCalled();
  expect(mocks.resolveProviderStaticModel).not.toHaveBeenCalled();
  expect(summary.sessions).toEqual({
    paths: [],
    count: 1,
    defaults: { model: null, contextTokens: null },
    recent: [],
    byAgent: [{ agentId: "main", path: "[redacted]", count: 1, recent: [] }],
  });
});

it("reports stale snapshot and cold credential owners without exposing ref identifiers", async () => {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "provider",
      ownerId: "openai",
      state: "unavailable",
      degradationState: "stale",
      paths: ["models.providers.openai.apiKey"],
      refKeys: ["env:default:PRIVATE_REF_ID"],
      reason: "provider SecretRef is unresolved (env:default:PRIVATE_REF_ID)",
    },
  ]);
  setActiveCredentialDegradedOwner({
    ownerKind: "account",
    ownerId: "telegram:work",
    state: "unavailable",
    paths: ["channels.telegram.accounts.work.tokenFile"],
    refKeys: [],
    reason: "credential failure includes PRIVATE_REF_ID",
  });
  const summary = await getStatusSummary();
  expect(summary.degradedSecretOwners).toMatchObject([
    { ownerId: "openai", degradationState: "stale", reason: "secret resolution failed" },
    { ownerId: "telegram:work", degradationState: "cold", reason: "secret resolution failed" },
  ]);
  expect(JSON.stringify(summary.degradedSecretOwners)).not.toContain("PRIVATE_REF_ID");
});

it("reports every plugin configured unavailable by startup verification", async () => {
  const plugins = [
    [
      "discord",
      "unreadable-package-json",
      "Could not read /private/plugins/d/package.json: permission denied",
      "Could not read <plugin-install>/package.json: permission denied",
      "/private/plugins/d",
    ],
    [
      "matrix",
      "missing-main-entry",
      "dist/index.js is missing",
      "dist/index.js is missing",
      undefined,
    ],
    [
      "peer-plugin",
      "missing-openclaw-peer-link",
      "/private/plugins/p points to /private/host",
      'Plugin declares peerDependency "openclaw", but its host peer link is missing or invalid.',
      "/private/plugins/p",
    ],
  ] as const;
  setActiveDegradedPlugins(
    plugins.map(([pluginId, reason, detail, , installPath]) => ({
      pluginId,
      state: "configured-unavailable",
      diagnostic: { kind: "plugin-verification", reason, detail, installPath },
    })),
  );
  const summary = await getStatusSummary();
  expect(summary.degradedPlugins).toMatchObject(
    plugins.map(([pluginId, reason, , detail]) => ({ pluginId, diagnostic: { reason, detail } })),
  );
  expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/plugins");
  expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/host");
});

it("skips channel summary imports when no channels are configured", async () => {
  mocks.hasConfiguredChannelsForReadOnlyScopeAsync.mockResolvedValue(false);
  const summary = await getStatusSummary();
  expect(summary.channelSummary).toStrictEqual([]);
  expect(summary.linkChannel).toBeUndefined();
  expect(mocks.hasConfiguredChannelsForReadOnlyScopeAsync).toHaveBeenCalledWith({
    config: {},
  });
  expect(buildChannelSummary).not.toHaveBeenCalled();
  expect(resolveLinkChannelContext).not.toHaveBeenCalled();
});

it("rejects wrong-version checkpoint usage provenance", async () => {
  setSession({
    totalTokens: 50_000,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION + 1,
  });
  const summary = await getStatusSummary();
  expect(summary.sessions.recent[0]).toMatchObject({
    totalTokens: 50_000,
    totalTokensFresh: false,
    remainingTokens: null,
    percentUsed: null,
  });
});

it("uses context-only static metadata for nested provider-owned model refs", async () => {
  const ref = modelRef("google-gemini-cli", "google/gemini-3.1-pro-preview");
  vi.mocked(runtime.resolveConfiguredStatusModelRef).mockReturnValue(ref);
  mocks.resolveProviderStaticModel.mockResolvedValueOnce({
    contextWindow: 1_048_576,
  });
  await getStatusSummary();
  expect(mocks.resolveProviderStaticModel).toHaveBeenCalledWith({
    provider: ref.provider,
    modelId: ref.model,
  });
  expect(vi.mocked(runtime.resolveContextTokensForModel).mock.calls[0]?.[0]).toMatchObject({
    ...ref,
    modelContextWindow: 1_048_576,
    allowAsyncLoad: false,
  });
});

it.each([32_768, undefined])(
  "uses admitted local capacity (%s) ahead of a previous model's window",
  async (capacity) => {
    vi.mocked(runtime.resolveContextTokensForModel).mockImplementation(
      resolveContextTokensForModelFromCache,
    );
    vi.mocked(runtime.resolveSessionModelRef).mockReturnValue(modelRef("ollama", "qwen3:4b"));
    mocks.getPreparedModelCatalogSnapshot.mockReturnValue({
      entries:
        capacity === undefined
          ? []
          : [
              {
                provider: "ollama",
                id: "qwen3:4b",
                name: "qwen3:4b",
                contextWindow: 262_144,
                contextTokens: capacity,
              },
            ],
      routeVariants: [],
    });
    setSession({
      modelProvider: "ollama",
      model: "qwen3:8b",
      agentHarnessId: "openclaw",
      contextTokens: 128_000,
      contextTokensSource: "resolved-v1",
    });
    const summary = await getStatusSummary();
    expect(summary.sessions.recent[0]).toMatchObject({
      model: "qwen3:4b",
      contextTokens: capacity ?? null,
    });
  },
);

it.each([
  ["pinned session", "user", false, "session override"],
  ["runtime-only snapshot", undefined, false, null],
  ["auto fallback", "auto", false, "fallback selected"],
  ["provider-local alias", "user", true, null],
] as const)(
  "reports configured and selected models for %s",
  async (_name, source, alias, reason) => {
    const configured = alias
      ? modelRef("anthropic", "claude-opus-4-8")
      : modelRef("zhipu", "glm-4.5-air");
    const selected = alias
      ? modelRef("anthropic", "opus")
      : modelRef("deepseek", "deepseek-v4-flash");
    vi.mocked(runtime.resolveConfiguredStatusModelRef).mockReturnValue(configured);
    vi.mocked(runtime.resolveSessionModelRef).mockReturnValue(selected);
    const entry: Record<string, unknown> = source
      ? {
          modelOverride: selected.model,
          modelOverrideSource: source,
          ...(!alias && { providerOverride: selected.provider }),
        }
      : { modelProvider: selected.provider, model: selected.model };
    if (source === "auto") {
      Object.assign(entry, {
        modelProvider: selected.provider,
        model: selected.model,
        modelOverrideFallbackOriginProvider: configured.provider,
        modelOverrideFallbackOriginModel: configured.model,
        agentHarnessId: "openclaw",
        contextTokens: 128_000,
        contextTokensSource: "runtime",
      });
    }
    if (alias) {
      const lookup = vi.mocked(runtime.resolveStatusModelLookupRef).getMockImplementation()!;
      const normalizeAlias: typeof runtime.resolveStatusModelLookupRef = (params) =>
        params.provider === selected.provider && params.model === selected.model
          ? configured
          : lookup(params);
      vi.mocked(runtime.resolveStatusModelLookupRef).mockImplementation(normalizeAlias);
      vi.mocked(runtime.resolveStatusModelComparisonLabel).mockImplementation((params) => {
        const ref = normalizeAlias(params);
        return ref ? `${ref.provider}/${ref.model}` : null;
      });
    }
    setSession(entry);
    const summary = await getStatusSummary();
    expect(summary.sessions.recent[0]).toMatchObject({
      configuredModel: `${configured.provider}/${configured.model}`,
      selectedModel: `${selected.provider}/${selected.model}`,
      modelSelectionReason: reason,
    });
    if (source === "auto") {
      expect(summary.sessions.recent[0]?.contextTokens).toBe(128_000);
    }
    if (alias) {
      expect(runtime.resolveSessionRuntime).toHaveBeenCalledWith(
        expect.objectContaining(configured),
      );
    }
  },
);

it("resolves aggregate selected models from each row's agent", async () => {
  const models: Record<string, string> = { ops: "ops", research: "research" };
  vi.mocked(runtime.resolveConfiguredStatusModelRef).mockImplementation(({ agentId }) => ({
    provider: "openai",
    model: models[agentId ?? ""] ?? "global",
  }));
  vi.mocked(runtime.resolveSessionModelRef).mockImplementation((model) => model);
  mocks.listSessionEntriesCore.mockReturnValue(
    toSessionEntrySummaries({
      "agent:ops:main": { sessionId: "ops-session", updatedAt: 3 },
      "agent:research:main": { sessionId: "research-session", updatedAt: 2 },
      "agent:main:main": { sessionId: "global-session", updatedAt: 1 },
    }),
  );
  const summary = await getStatusSummary();
  const selected = summary.sessions.recent.map(({ selectedModel }) => selectedModel);
  expect(selected).toEqual(["openai/ops", "openai/research", "openai/global"]);
  expect(summary.sessions.count).toBe(3);
  expect(summary.sessions.byAgent[0]?.count).toBe(1);
  expect(summary.sessions.byAgent[0]?.recent.map(({ key }) => key)).toEqual(["agent:main:main"]);
  const { calls } = vi.mocked(runtime.readSessionRuntimeMetadata).mock;
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1].map(({ sessionKey }) => sessionKey)).toEqual([
    "agent:ops:main",
    "agent:research:main",
    "agent:main:main",
  ]);
});

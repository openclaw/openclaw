import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
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

const statusSummaryMocks = vi.hoisted(() => ({
  readHeartbeatSummarySnapshot: vi.fn(async () => [] as import("../cron/types.js").CronJob[]),
  hasConfiguredChannelsForReadOnlyScope: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  resolveProviderStaticModel: vi.fn(),
  listSessionEntriesCore: vi.fn<
    (scope?: { agentId?: string; storePath?: string }) => Array<{
      sessionKey: string;
      entry: Record<string, unknown>;
    }>
  >(() => []),
  readSessionEntriesFromStoreInWorker:
    vi.fn<
      typeof import("../config/sessions/session-entry-read-runtime.js").readSessionEntriesFromStoreInWorker
    >(),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope,
}));

vi.mock("../status/summary.runtime.js", () => ({
  statusSummaryRuntime: {
    classifySessionKey: vi.fn(() => "direct"),
    resolveConfiguredStatusModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.5",
    })),
    resolveSessionModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.5",
    })),
    resolveSessionRuntime: vi.fn(() => ({ id: "openclaw", label: "OpenClaw Default" })),
    resolveStatusModelLookupRef: vi.fn(({ provider, model }) =>
      typeof model === "string" && model.length > 0
        ? {
            provider: typeof provider === "string" && provider.length > 0 ? provider : "openai",
            model,
          }
        : null,
    ),
    resolveStatusModelComparisonLabel: vi.fn(({ provider, model }) =>
      typeof model === "string" && model.length > 0
        ? `${typeof provider === "string" && provider.length > 0 ? provider : "openai"}/${model}`
        : null,
    ),
    resolveAuthoredModelContextTokens: vi.fn(() => undefined),
    resolveContextTokensForModel: vi.fn(() => 200_000),
    waitForContextWindowCacheLoad: vi.fn(async () => "idle" as const),
  },
}));

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
  createBundledProviderStaticCatalogContextResolver: vi.fn(
    () => statusSummaryMocks.resolveProviderStaticModel,
  ),
}));

vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn((config) => config),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../infra/heartbeat-summary-snapshot.js", async (original) => ({
  ...(await original<typeof import("../infra/heartbeat-summary-snapshot.js")>()),
  readHeartbeatSummarySnapshot: statusSummaryMocks.readHeartbeatSummarySnapshot,
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { createSessionStoreSummaryReaderStub } =
    await import("../config/sessions/session-store-summary.test-support.js");
  return {
    readSessionEntriesFromStoreInWorker: statusSummaryMocks.readSessionEntriesFromStoreInWorker,
    withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub((scope, options) => {
      const entries = statusSummaryMocks
        .listSessionEntriesCore(scope)
        .filter(({ sessionKey }) => sessionKey.startsWith("agent:"))
        .map(({ sessionKey, entry }) => ({
          sessionKey,
          entry: { sessionId: sessionKey, updatedAt: 0, ...entry },
        }))
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
  buildChannelSummary: statusSummaryMocks.buildChannelSummary,
}));

vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: vi.fn(() => []),
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    LEGACY_IMPLICIT_AGENT_ID: "main",
    normalizeAgentId: vi.fn((value: string) => value),
    normalizeMainKey: vi.fn((value?: string) => value ?? "main"),
    parseAgentSessionKey: vi.fn(actual.parseAgentSessionKey),
  };
});

vi.mock("../version.js", async () => {
  const actual = await vi.importActual<typeof import("../version.js")>("../version.js");
  return {
    ...actual,
    resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
  };
});

vi.mock("../status/link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

const { buildChannelSummary } = await import("../infra/channel-summary.js");
const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
const { peekSystemEvents } = await import("../infra/system-events.js");
const { resolveLinkChannelContext } = await import("../status/link-channel.js");
let statusSummaryRuntime: typeof import("../status/summary.runtime.js").statusSummaryRuntime;

function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}

function setSession(entry: Record<string, unknown>) {
  statusSummaryMocks.listSessionEntriesCore.mockReturnValue([
    { sessionKey: "agent:main:main", entry: { sessionId: "session-1", updatedAt: 100, ...entry } },
  ]);
}

describe("getStatusSummary", () => {
  beforeAll(async () => {
    ({ statusSummaryRuntime } = await import("../status/summary.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    statusSummaryMocks.readHeartbeatSummarySnapshot.mockResolvedValue([]);
    setActiveDegradedPlugins([]);
    clearActiveCredentialDegradedOwner("account", "telegram:work");
    setActiveDegradedSecretOwners([]);
    statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope.mockReturnValue(true);
    statusSummaryMocks.resolveProviderStaticModel.mockReset();
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue([]);
    vi.mocked(peekSystemEvents).mockReset().mockReturnValue([]);
    statusSummaryMocks.readSessionEntriesFromStoreInWorker.mockImplementation(async (input) => ({
      kind: "session-exact-entries",
      lifecycleTimestamps: {},
      entries: statusSummaryMocks
        .listSessionEntriesCore()
        .filter(({ sessionKey }) => input.sessionKeys?.includes(sessionKey))
        .map(({ sessionKey, entry }) => ({
          sessionKey,
          entry: { sessionId: sessionKey, updatedAt: 0, ...entry },
        })),
    }));
    vi.mocked(statusSummaryRuntime.resolveAuthoredModelContextTokens).mockReturnValue(undefined);
    vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mockReturnValue(200_000);
    vi.mocked(statusSummaryRuntime.resolveSessionRuntime).mockReturnValue({
      id: "openclaw",
      label: "OpenClaw Default",
    });
    vi.mocked(listGatewayAgentsBasic).mockResolvedValue({
      defaultId: "main",
      ownership: "sole",
      selectionRequired: false,
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
  });

  registerStatusSummarySessionRowCases({
    getStatusSummary: () => getStatusSummary(),
    getStatusSummaryRuntime: () => statusSummaryRuntime,
    rejectProviderStaticModel: (error) =>
      statusSummaryMocks.resolveProviderStaticModel.mockRejectedValueOnce(error),
    setSessions: (store) =>
      statusSummaryMocks.listSessionEntriesCore.mockReturnValue(toSessionEntrySummaries(store)),
  });
  registerStatusSummaryWalCases((options) => getStatusSummary(options));

  it("summarizes every configured agent's global pending events without an ambient owner", async () => {
    const scope = "global";
    const agents = [{ id: "research" }, { id: "ops" }];
    vi.mocked(listGatewayAgentsBasic).mockResolvedValue({
      defaultId: "research",
      mainKey: "inbox",
      scope,
      agents,
      ownership: "explicit",
      selectionRequired: true,
    });
    vi.mocked(peekSystemEvents).mockImplementation((key) => [`pending: ${key}`]);

    const summary = await getStatusSummary({
      config: {
        agents: {
          ownership: "explicit",
          entries: { research: {}, ops: {} },
        },
        session: { scope, mainKey: "inbox" },
      },
      includeSensitive: false,
      includeChannelSummary: false,
    });

    expect(summary.sessions.byAgent.map((agent) => agent.agentId)).toEqual(["research", "ops"]);
    expect(summary.queuedSystemEvents).toEqual([
      "pending: agent:research:global",
      "pending: agent:ops:global",
    ]);
  });

  it.each([false, true])(
    "reads the converted automation session route (empty=%s)",
    async (empty) => {
      const main = "agent:main:main";
      const configured = "agent:main:telegram:alerts";
      statusSummaryMocks.listSessionEntriesCore.mockReturnValue([
        {
          sessionKey: empty ? main : configured,
          entry: {
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "123" },
            }),
          },
        },
        { sessionKey: empty ? configured : main, entry: {} },
      ]);
      statusSummaryMocks.readHeartbeatSummarySnapshot.mockResolvedValue([
        makeCronJob({
          agentId: "main",
          sessionTarget: "session:agent:main:telegram:alerts",
          delivery: { mode: "announce", channel: "last" },
        }),
      ]);
      const summary = await getStatusSummary({ config: {} });
      expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(empty);
    },
  );

  it("does not read an unused route for a disabled heartbeat", async () => {
    statusSummaryMocks.readHeartbeatSummarySnapshot.mockResolvedValue([
      makeCronJob({
        agentId: "main",
        enabled: false,
        delivery: { mode: "announce", target: "owner" },
      }),
    ]);
    const summary = await getStatusSummary({ config: {}, includeChannelSummary: false });
    expect(summary.heartbeat.agents[0]).toMatchObject({ enabled: false, waitingForRoute: false });
    expect(statusSummaryMocks.readSessionEntriesFromStoreInWorker).not.toHaveBeenCalled();
  });

  it("skips session model discovery and projection when sensitive output is disabled", async () => {
    setSession({ model: "gpt-5.5", modelProvider: "openai", totalTokens: 42 });

    const summary = await getStatusSummary({ includeSensitive: false });

    expect(statusSummaryRuntime.waitForContextWindowCacheLoad).not.toHaveBeenCalled();
    expect(statusSummaryRuntime.resolveConfiguredStatusModelRef).not.toHaveBeenCalled();
    expect(statusSummaryRuntime.resolveSessionRuntime).not.toHaveBeenCalled();
    expect(statusSummaryMocks.resolveProviderStaticModel).not.toHaveBeenCalled();
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

    expect(
      summary.degradedSecretOwners.map(({ ownerId, degradationState, reason }) => [
        ownerId,
        degradationState,
        reason,
      ]),
    ).toEqual([
      ["openai", "stale", "secret resolution failed"],
      ["telegram:work", "cold", "secret resolution failed"],
    ]);
    expect(JSON.stringify(summary.degradedSecretOwners)).not.toContain("PRIVATE_REF_ID");
  });

  it("reports every plugin configured unavailable by startup verification", async () => {
    const plugins = [
      [
        "discord",
        "unreadable-package-json",
        "Could not read /private/plugins/discord/package.json: permission denied",
        "/private/plugins/discord",
      ],
      ["matrix", "missing-main-entry", "dist/index.js is missing", undefined],
      [
        "peer-plugin",
        "missing-openclaw-peer-link",
        "/private/plugins/peer-plugin/node_modules/openclaw points to /private/other/openclaw instead of /private/host/openclaw",
        "/private/plugins/peer-plugin",
      ],
    ] as const;
    setActiveDegradedPlugins(
      plugins.map(([pluginId, reason, detail, installPath]) => ({
        pluginId,
        state: "configured-unavailable",
        diagnostic: { kind: "plugin-verification", reason, detail, installPath },
      })),
    );

    const summary = await getStatusSummary();

    expect(
      summary.degradedPlugins.map(({ pluginId, diagnostic }) => [
        pluginId,
        diagnostic.reason,
        diagnostic.detail,
      ]),
    ).toEqual([
      [
        "discord",
        "unreadable-package-json",
        "Could not read <plugin-install>/package.json: permission denied",
      ],
      ["matrix", "missing-main-entry", "dist/index.js is missing"],
      [
        "peer-plugin",
        "missing-openclaw-peer-link",
        'Plugin declares peerDependency "openclaw", but its host peer link is missing or invalid.',
      ],
    ]);
    expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/plugins");
    expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/host");
  });

  it("skips channel summary imports when no channels are configured", async () => {
    statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope.mockReturnValue(false);

    const summary = await getStatusSummary();

    expect(summary.channelSummary).toStrictEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope).toHaveBeenCalledWith({
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
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "google-gemini-cli",
      model: "google/gemini-3.1-pro-preview",
    });
    statusSummaryMocks.resolveProviderStaticModel.mockResolvedValueOnce({
      contextWindow: 1_048_576,
    });

    await getStatusSummary();

    expect(statusSummaryMocks.resolveProviderStaticModel).toHaveBeenCalledWith({
      provider: "google-gemini-cli",
      modelId: "google/gemini-3.1-pro-preview",
    });
    expect(
      vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mock.calls[0]?.[0],
    ).toMatchObject({
      provider: "google-gemini-cli",
      model: "google/gemini-3.1-pro-preview",
      modelContextWindow: 1_048_576,
      allowAsyncLoad: false,
    });
  });

  it.each([
    {
      name: "pinned session",
      entry: {
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "user",
      },
      reason: "session override",
    },
    {
      name: "runtime-only snapshot",
      entry: { modelProvider: "deepseek", model: "deepseek-v4-flash" },
      reason: null,
    },
    {
      name: "auto fallback",
      entry: {
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "zhipu",
        modelOverrideFallbackOriginModel: "glm-4.5-air",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
        agentHarnessId: "openclaw",
        contextTokens: 128_000,
        contextTokensSource: "runtime",
      },
      reason: "fallback selected",
    },
  ])("reports configured and selected models for $name", async ({ entry, reason }) => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    setSession(entry);
    const summary = await getStatusSummary();
    expect(summary.sessions.recent[0]).toMatchObject({
      configuredModel: "zhipu/glm-4.5-air",
      selectedModel: "deepseek/deepseek-v4-flash",
      modelSelectionReason: reason,
    });
    if (entry.contextTokens) {
      expect(summary.sessions.recent[0]?.contextTokens).toBe(128_000);
    }
  });

  it("does not mark provider-local model aliases as pinned mismatches", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "anthropic",
      model: "opus",
    });
    const normalizeRef = ({
      provider,
      model,
    }: Parameters<typeof statusSummaryRuntime.resolveStatusModelLookupRef>[0]) => {
      if (provider === "anthropic" && model === "opus") {
        return { provider: "anthropic", model: "claude-opus-4-8" };
      }
      return typeof model === "string" && model.length > 0
        ? {
            provider: typeof provider === "string" && provider.length > 0 ? provider : "openai",
            model,
          }
        : null;
    };
    vi.mocked(statusSummaryRuntime.resolveStatusModelLookupRef).mockImplementation(normalizeRef);
    vi.mocked(statusSummaryRuntime.resolveStatusModelComparisonLabel).mockImplementation(
      (params) => {
        const ref = normalizeRef(params);
        return ref ? `${ref.provider}/${ref.model}` : null;
      },
    );
    setSession({ modelOverride: "opus", modelOverrideSource: "user" });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("anthropic/claude-opus-4-8");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("anthropic/opus");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
    expect(statusSummaryRuntime.resolveSessionRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-8",
      }),
    );
  });

  it("resolves aggregate selected models from each row's agent", async () => {
    const models: Record<string, string> = { ops: "ops", research: "research" };
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockImplementation(
      ({ agentId }) => ({ provider: "openai", model: models[agentId ?? ""] ?? "global" }),
    );
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockImplementation((model) => model);
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
  });
});

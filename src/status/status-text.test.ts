import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { InternalSessionEntry, SessionContextBudgetStatus } from "../config/sessions/types.js";
import * as transcriptTail from "../gateway/session-transcript-readers.js";
import * as transcriptUsage from "../gateway/session-transcript-usage.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { buildStatusText, buildStatusReplyParts } from "./status-text.js";

const mocks = vi.hoisted(() => ({
  loadSessionCostSummariesFromCache: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

vi.mock(import("../infra/session-cost-usage.js"), async (original) => ({
  ...(await original()),
  loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
}));

vi.mock(import("../infra/provider-usage.js"), async (original) => ({
  ...(await original()),
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

type StatusTextParams = Parameters<typeof buildStatusText>[0];

function statusParams(overrides: Partial<StatusTextParams>): StatusTextParams {
  return {
    cfg: {},
    sessionKey: "agent:main:main",
    statusChannel: "mobilechat",
    provider: "openai",
    model: "gpt-5.4-mini",
    resolvedHarness: "openclaw",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
    modelAuthOverride: "api-key",
    activeModelAuthOverride: "api-key",
    includeTranscriptUsage: false,
    ...overrides,
  };
}

const render = (overrides: Partial<StatusTextParams>) => buildStatusText(statusParams(overrides));
const makeEntry = (patch: Partial<NonNullable<StatusTextParams["sessionEntry"]>> = {}) => ({
  sessionId: "status",
  updatedAt: 0,
  ...patch,
});
const renderTelegramStatus = (params: Partial<StatusTextParams>) =>
  render({
    sessionEntry: makeEntry(),
    statusChannel: "telegram",
    resolvedHarness: "pi",
    pluginHealthLineOverride: "Plugins: test",
    primaryModelLabelOverride: "openai/gpt-5.4-mini",
    modelAuthOverride: "test",
    activeModelAuthOverride: "test",
    ...params,
  });

describe("buildStatusText channel features", () => {
  const accountConfig = {
    channels: { telegram: { richMessages: true, accounts: { Work: { richMessages: false } } } },
  };
  it.each<[Partial<StatusTextParams>, string, string]>([
    [{ cfg: { channels: { telegram: {} } } }, "off", "channels.telegram.richMessages=true"],
    [{ cfg: { channels: { telegram: { richMessages: true } } } }, "on", "sendRichMessage enabled"],
    [
      {
        cfg: accountConfig,
        sessionEntry: makeEntry({
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", accountId: "work" },
          }),
        }),
      },
      "off",
      "enable richMessages for this Telegram account",
    ],
    [
      { cfg: accountConfig, statusAccountId: "work" },
      "off",
      "enable richMessages for this Telegram account",
    ],
  ])("renders Telegram features for %j", async (params, enabled, hint) => {
    const text = await renderTelegramStatus(params);
    expect(text).toContain(`Telegram rich messages: ${enabled}`);
    expect(text).toContain(hint);
  });
});

describe("buildStatusText global subagent scope", () => {
  beforeEach(() => resetSubagentRegistryForTests({ persist: false }));
  afterEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
  });

  it("shows the selected global agent's children instead of the default agent's", async () => {
    const cfg: StatusTextParams["cfg"] = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { research: {}, ops: {} },
      },
      session: { scope: "global" },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["research", "ops"]) {
      seedSubagentRunForReadTest({
        runId: `status-global-${agentId}`,
        childSessionKey: `agent:${agentId}:subagent:status-worker`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
        task: `${agentId} status worker`,
        cleanup: "keep",
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
      });
    }

    const text = await renderTelegramStatus({
      cfg,
      sessionEntry: makeEntry(),
      sessionKey: "global",
      agentId: "research",
    });

    expect(text).toContain("🤖 Subagents: 1 active");
    expect(text).toContain("research status worker");
    expect(text).not.toContain("ops status worker");
  });
});

describe("Codex usage after runtime fallback", () => {
  beforeEach(() => {
    mocks.loadProviderUsageSummary.mockReset();
    mocks.loadProviderUsageSummary.mockImplementation(async (params) => ({
      updatedAt: Date.now(),
      providers: params.auth
        ? [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 25 }],
            },
          ]
        : [],
    }));
  });

  const renderFallbackStatus = (agentHarnessId: "codex" | "openclaw") =>
    render({
      sessionEntry: makeEntry({ agentRuntimeOverride: "openclaw", agentHarnessId }),
      pluginHealthLineOverride: "Plugins: test",
      primaryModelLabelOverride: "openai/gpt-5.4-mini",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
    });

  it("shows Codex rate-limit usage for a Codex-bound session on OpenClaw Default", async () => {
    const text = await renderFallbackStatus("codex");

    expect(text).toContain("📊 Usage: 5h 75% left");
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["openai"],
        auth: [expect.objectContaining({ provider: "openai", hookProvider: "codex" })],
      }),
    );
  });

  it("omits Codex rate-limit usage for a never-Codex session", async () => {
    const text = await renderFallbackStatus("openclaw");

    expect(text).not.toContain("📊 Usage:");
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    );
  });
});

describe("session status cost line", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  const sessionEntry = {
    sessionId: "cost-session",
    updatedAt: 0,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "cost-session",
      storePath: "/tmp/retired-status-cost/agents/main/agent/openclaw-agent.sqlite",
    }),
  };

  const costSummary = {
    input: 400_000,
    output: 56_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 456_000,
    totalCost: 1.23,
    inputCost: 1,
    outputCost: 0.23,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };

  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("status-cost-"),
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    mocks.loadSessionCostSummariesFromCache.mockReset();
    mocks.loadProviderUsageSummary.mockReset().mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 25 }] },
      ],
    });
  });

  const renderCostStatus = () =>
    render({
      sessionEntry,
      storePath,
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
      pluginHealthLineOverride: "Plugins: test",
    });

  it.each([
    ["fresh", 0, "💵 $1.23 · 456k tok (today)"],
    [
      "fresh",
      12,
      "💵 missing cost: 12 (openai/gpt-5.6-sol 10, openai-codex/gpt-5.5 2) · 456k tok (today)",
    ],
    ["stale", 0, undefined],
  ] as const)(
    "renders %s cost with %i missing prices",
    async (status, missingCostEntries, expected) => {
      mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
        cacheStatus: {
          status,
          cachedFiles: status === "fresh" ? 1 : 0,
          pendingFiles: status === "fresh" ? 0 : 1,
          staleFiles: status === "stale" ? 1 : 0,
        },
        summaries: [
          {
            ...costSummary,
            missingCostEntries,
            ...(missingCostEntries
              ? { missingCostByModel: { "openai/gpt-5.6-sol": 10, "openai-codex/gpt-5.5": 2 } }
              : {}),
          },
        ],
      });
      const text = await renderCostStatus();
      if (expected) {
        expect(text).toContain(expected);
      } else {
        expect(text).not.toContain("💵");
      }
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: [
            { sessionId: "cost-session", sessionFile: `sqlite:main:cost-session:${storePath}` },
          ],
        }),
      );
    },
  );

  it("preserves existing usage when the session cost cache fails", async () => {
    mocks.loadSessionCostSummariesFromCache.mockRejectedValue(new Error("cache unavailable"));
    const text = await renderCostStatus();
    expect(text).toContain("📊 Usage: 5h 75% left");
    expect(text).not.toContain("💵");
  });
});

describe("buildStatusText thinking facts", () => {
  it.each([
    { reasoning: true, expected: "think high" },
    { reasoning: false, expected: "think off (requested high; clamped)" },
  ])(
    "shows requested and effective thinking for an Ollama model (reasoning=$reasoning)",
    async ({ reasoning, expected }) => {
      const text = await render({
        sessionEntry: makeEntry({
          thinkingLevel: "high",
          modelOverride: "glm-5.2:cloud",
          providerOverride: "ollama",
        }),
        statusChannel: "whatsapp",
        provider: "ollama",
        model: "glm-5.2:cloud",
        thinkingCatalog: [
          {
            provider: "ollama",
            id: "glm-5.2:cloud",
            reasoning,
          },
        ],
        resolvedThinkLevel: "high",
        resolvedReasoningLevel: "on",
        resolveDefaultThinkingLevel: async () => "high",
        pluginHealthLineOverride: "Plugins: test",
        primaryModelLabelOverride: "ollama/glm-5.2:cloud",
        modelAuthOverride: "local",
        activeModelAuthOverride: "local",
      });

      expect(text).toContain(expected);
    },
  );
});

const selected = { provider: "deepseek", model: "deepseek-v4-flash" };
const active = { provider: "fallback", model: "small-model" };
const modelEntry = ({ provider, model }: typeof selected) => ({ modelProvider: provider, model });
const modelLimits = (provider: string, id: string, contextWindow?: number) => ({
  provider,
  id,
  contextWindow,
  contextTokens: contextWindow,
});
const assistant = (patch: Record<string, unknown> = {}, runId = "settled-run") =>
  attachSessionTranscriptRunId(
    {
      role: "assistant",
      ...active,
      stopReason: "stop",
      content: [{ type: "text", text: "Synthetic response" }],
      ...patch,
    },
    runId,
  );
function expectFallback(
  parts: Awaited<ReturnType<typeof buildStatusReplyParts>>,
  context = "45k/128k",
) {
  expect(parts.text).toContain("Fallback: fallback/small-model");
  expect(parts.text).toContain(`Context: ${context}`);
}
function expectContext(parts: Awaited<ReturnType<typeof buildStatusReplyParts>>, context: string) {
  expect(parts.text).toContain(`Context: ${context}`);
  const table = parts.presentation.blocks.find((block) => block.type === "table");
  expect(table?.type === "table" ? table.rows : []).toContainEqual([
    "📚 Context",
    expect.stringContaining(context),
  ]);
}

describe("buildStatusText prepared context windows", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "status-model" });
    mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
      summaries: [null],
      cacheStatus: { status: "partial", cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
    });
    const actual = await vi.importActual<typeof import("../infra/provider-usage.js")>(
      "../infra/provider-usage.js",
    );
    mocks.loadProviderUsageSummary.mockImplementation(actual.loadProviderUsageSummary);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });
  const tokenUsage = {
    totalTokens: 45_000,
    totalTokensFresh: true,
    totalTokensVersion: 1,
  } satisfies Partial<InternalSessionEntry>;
  const fallbackNotice = {
    kind: "active",
    selectedModel: "deepseek/deepseek-v4-flash",
    activeModel: "fallback/small-model",
  } satisfies NonNullable<InternalSessionEntry["fallbackNotice"]>;
  const notice = (patch: Partial<NonNullable<InternalSessionEntry["fallbackNotice"]>>) => ({
    ...fallbackNotice,
    ...patch,
  });
  const noticeEntry = (patch: Parameters<typeof notice>[0]) => ({ fallbackNotice: notice(patch) });
  const catalog = [
    modelLimits(selected.provider, selected.model, 1_000_000),
    modelLimits(active.provider, active.model, 128_000),
    modelLimits("openrouter", "deepseek/deepseek-v4-flash", 1_000_000),
  ];

  const prepared = (overrides: Partial<StatusTextParams> = {}) =>
    buildStatusReplyParts(
      statusParams({
        sessionEntry: makeEntry({ sessionId: "prepared-context", ...tokenUsage }),
        ...selected,
        thinkingCatalog: catalog,
        pluginHealthLineOverride: "Plugins: test",
        ...overrides,
      }),
    );

  it("prepares bounded usage off-thread and sees a later committed transcript", async () => {
    const target = {
      agentId: "main",
      sessionId: "status-worker-usage",
      sessionKey: "agent:main:status-worker-usage",
      storePath: state.statePath("status.sqlite"),
    };
    const entry = { sessionId: target.sessionId, updatedAt: 1 };
    const readUsage = vi.spyOn(transcriptUsage, "readRecentSessionUsageFromTranscriptAsync");
    await replaceSessionEntry(target, entry);
    const appendUsage = async (content: string, input: number, output: number) => {
      await appendTranscriptMessage(target, {
        message: {
          role: "assistant",
          content,
          usage: { input, output, totalTokens: input + output },
        },
      });
      await waitForSessionTranscriptProjection(target);
    };
    await appendUsage("x".repeat(300_000), 10, 2);
    openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const reads: string[] = [];
    observeHostDataSql((sql, database) => {
      if (
        !database &&
        /\b(?:transcript_events|session_transcript_active_events|transcript_event_identities)\b/iu.test(
          sql,
        )
      ) {
        reads.push(sql);
      }
    });
    const renderUsage = (sessionEntry: InternalSessionEntry = entry) =>
      prepared({
        sessionEntry,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        includeTranscriptUsage: true,
      });
    setRuntimeConfigSnapshot({});
    const first = await renderUsage();
    // The newest message still contributes usage when its body exceeds the byte budget.
    expect(first.text).toContain("Tokens: 10 in / 2 out");
    expect(reads).toEqual([]);

    await appendUsage("New usage", 30, 4);
    reads.length = 0;
    const latest = await renderUsage();
    expect(latest.text).toContain("Tokens: 30 in / 4 out");
    expect(reads).toEqual([]);

    const committedEntry = {
      ...entry,
      ...modelEntry(selected),
      ...tokenUsage,
      inputTokens: 60,
      outputTokens: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
    } satisfies InternalSessionEntry;
    await replaceSessionEntry(target, committedEntry);
    readUsage.mockClear();
    const committed = await renderUsage(committedEntry);
    expect(committed.text).toContain("Tokens: 60 in / 6 out");
    expect(readUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["current discovered limits", 262_144, "45k/262k", undefined, undefined],
    ["unknown limits", undefined, "45k/?", undefined, undefined],
    ["another runtime's limits", 262_144, "45k/?", "other-runtime", undefined],
    ["API limits for a native runtime", 262_144, "45k/?", undefined, "fixture-native"],
  ] as const)(
    "renders %s without reusing a stale cache or estimate",
    async (_name, window, expected, nativeRuntime, resolvedHarness) => {
      const provider = "ollama";
      const model = "qwen3:8b";
      const key = providerContextTokenCacheKey(provider, model);
      const caches = getContextWindowCaches();
      const cacheMaps = [caches.discoveredTokenCache, caches.contextWindowCache];
      const previous = cacheMaps.map((cache) => cache.get(key));
      for (const cache of cacheMaps) {
        cache.set(key, 128_000);
      }
      try {
        const parts = await prepared({
          provider,
          model,
          resolvedHarness: resolvedHarness ?? "openclaw",
          contextTokens: 200_000,
          thinkingCatalog: [{ ...modelLimits(provider, model, window), nativeRuntime }],
        });

        expectContext(parts, expected);
      } finally {
        cacheMaps.forEach((cache, index) => {
          const value = previous[index];
          return value === undefined ? cache.delete(key) : cache.set(key, value);
        });
      }
    },
  );

  it("renders the agent thinking default ahead of model and global defaults", async () => {
    const models = { "fixture/reasoning-model": { params: { thinking: "high" } } };
    const parts = await prepared({
      cfg: {
        agents: {
          defaults: { thinkingDefault: "low", models },
          entries: { main: { thinkingDefault: "minimal", models } },
        },
      },
      provider: "fixture",
      model: "reasoning-model",
      thinkingCatalog: [{ provider: "fixture", id: "reasoning-model", reasoning: true }],
    });

    expect(parts.text).toContain("think minimal");
  });

  it.each([
    [
      "selected auto cutoff during fallback",
      "auto",
      {
        ...modelEntry({ provider: "openai", model: "base-model" }),
        fallbackNotice: notice({
          selectedModel: "anthropic/selected-model",
          activeModel: "openai/base-model",
          reason: "provider unavailable",
        }),
      },
      undefined,
      "auto (120 sec)",
    ],
    ["session off overrides model on", true, { fastMode: false }, undefined, "off"],
    ["prepared off overrides model on", true, {}, false, "off"],
  ] as const)(
    "renders fast mode for %s",
    async (_name, configured, entry, resolvedFastMode, expected) => {
      const models = {
        "openai/base-model": { params: { fastMode: !configured, fastAutoOnSeconds: 30 } },
        "anthropic/selected-model": { params: { fastMode: configured, fastAutoOnSeconds: 120 } },
      };
      const parts = await prepared({
        cfg: { agents: { defaults: { models } } },
        sessionEntry: makeEntry({
          providerOverride: "anthropic",
          modelOverride: "selected-model",
          ...entry,
        }),
        resolvedFastMode,
        provider: "openai",
        model: "base-model",
      });

      expect(parts.text).toContain(`fast ${expected}`);
    },
  );

  async function terminal(
    params: {
      entry?: Partial<InternalSessionEntry>;
      live?: boolean;
      message?: Record<string, unknown>;
      laterMessage?: Record<string, unknown>;
      status?: Partial<StatusTextParams>;
    } = {},
  ) {
    return await withTempHome(async () => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        sessionId: "terminal-fallback",
        sessionKey: "agent:main:main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const entry: InternalSessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        status: "done",
        lastRunId: "settled-run",
        ...modelEntry(selected),
        agentHarnessId: "openclaw",
        contextTokens: 1_000_000,
        contextTokensSource: "runtime",
        ...tokenUsage,
        fallbackNotice: { ...fallbackNotice, reason: "provider unavailable" },
        ...params.entry,
      };
      replaceSessionEntrySync(scope, entry);
      const append = (message: Record<string, unknown>) => {
        expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
      };
      append(assistant(params.message));
      if (params.laterMessage) {
        append(params.laterMessage);
      }
      const original = loadSessionEntryReadOnly(scope);
      const runId = "current-live-run";
      if (params.live) {
        registerAgentRunContext(runId, { ...scope, projectSessionActive: true });
      }
      try {
        const parts = await prepared({
          sessionEntry: original,
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          contextTokens: 1_000_000,
          ...params.status,
        });
        expect(loadSessionEntryReadOnly(scope)).toEqual(original);
        return parts;
      } finally {
        if (params.live) {
          clearAgentRunContext(runId);
        }
      }
    });
  }

  it.each([
    {},
    {
      status: { provider: "MiXeD", model: "Vendor/Model:opaque" },
      entry: noticeEntry({ selectedModel: "mixed/Vendor/Model:opaque" }),
    },
    {
      entry: {
        modelOverride: "MiXeD/Model:Case",
        ...noticeEntry({ selectedModel: "MiXeD/Model:Case" }),
      },
    },
  ] satisfies Array<Parameters<typeof terminal>[0]>)(
    "projects a settled fallback without relabeling persisted state: %j",
    async (params) => {
      const parts = await terminal(params);
      expectFallback(parts);
      expect(parts.text).not.toContain("45k/1.0m");
      expectContext(parts, "45k/128k");
    },
  );

  it.each([
    ["running session", { live: true }],
    ["missing run", { entry: { lastRunId: undefined } }],
    ["failed assistant", { message: { stopReason: "error" } }],
    ["hidden assistant", { message: { content: [] } }],
    ["undisplayed assistant", { message: { display: false } }],
    ["oversized tail", { message: { content: [{ type: "text", text: "x".repeat(300_000) }] } }],
    ["later user", { laterMessage: { role: "user", content: "New turn" } }],
    [
      "later run",
      {
        laterMessage: assistant({ content: [{ type: "text", text: "Other run" }] }, "other-run"),
      },
    ],
    ["unmatched active notice", { entry: noticeEntry({ activeModel: "fallback/other-model" }) }],
  ] satisfies Array<[string, Parameters<typeof terminal>[0]]>)(
    "does not project terminal fallback for %s",
    async (_name, params) => {
      const parts = await terminal(params);
      expect(parts.text).not.toContain("Fallback: fallback/small-model");
      expect(parts.text).toContain("Context: 45k/1.0m");
    },
  );

  it("skips terminal transcript access for a stale selected notice", async () => {
    const readTail = vi.spyOn(transcriptTail, "readSessionTranscriptBoundedMessageTailPageAsync");
    const parts = await terminal({
      entry: noticeEntry({ selectedModel: "deepseek/older-model" }),
    });
    expect(parts.text).not.toContain("Fallback: fallback/small-model");
    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(readTail).not.toHaveBeenCalled();
  });

  it("uses the admitted effective cap for the terminal pair", async () => {
    const parts = await terminal({
      entry: { providerOverride: "deepseek", modelOverride: "deepseek-v4-flash" },
      status: {
        ...active,
        thinkingCatalog: catalog.map(({ provider, id, contextWindow }) => ({
          provider,
          id,
          contextWindow,
          contextTokens: id === "small-model" ? 96_000 : contextWindow,
        })),
      },
    });
    expectFallback(parts, "45k/96k");
  });

  it.each([
    ["accepted terminal pair", "fallback/small-model"],
    ["legacy usage fallback", "usage/previous-model"],
  ])("keeps %s through independent usage hydration", async (_name, activeModel) => {
    const readUsage = vi
      .spyOn(transcriptUsage, "readRecentSessionUsageFromTranscriptAsync")
      .mockResolvedValue({
        ...modelEntry({ provider: "usage", model: "previous-model" }),
        inputTokens: 10,
        outputTokens: 2,
      });
    const parts = await terminal({
      entry: {
        modelProvider: undefined,
        model: undefined,
        ...noticeEntry({ activeModel, reason: "provider unavailable" }),
      },
      status: { includeTranscriptUsage: true },
    });
    expect(readUsage).toHaveBeenCalled();
    expect(parts.text).toContain(`Fallback: ${activeModel}`);
  });

  const budget = contextBudgetStatusFixture({
    updatedAt: 1,
    ...active,
    estimatedPromptTokens: 64_000,
    contextTokenBudget: 128_000,
    promptBudgetBeforeReserve: 100_000,
    reserveTokens: 28_000,
    effectiveReserveTokens: 28_000,
    remainingPromptBudgetTokens: 36_000,
    sessionId: "terminal-fallback",
  });
  it.each([
    ["matching budget", {}, true],
    ["selected model budget", { provider: "deepseek", model: "deepseek-v4-flash" }, false],
  ] satisfies Array<[string, Partial<SessionContextBudgetStatus>, boolean]>)(
    "projects only a %s owned by the terminal model",
    async (_name, patch, expected) => {
      const parts = await terminal({
        entry: {
          totalTokens: undefined,
          contextBudgetStatus: { ...budget, ...patch },
        },
      });
      expect(parts.text).toContain("Fallback: fallback/small-model");
      expect(parts.text.includes("64k")).toBe(expected);
      expect(parts.text).toContain("128k");
    },
  );

  it.each([
    ["", "Vendor/Model:opaque", { providerOverride: "" }, "Vendor/Model:opaque"],
    [
      "candidate",
      "entry",
      { providerOverride: "candidate", modelOverride: "middle" },
      "candidate/middle",
    ],
  ] satisfies Array<[string, string, Partial<InternalSessionEntry>, string]>)(
    "preserves typed selection %s/%s",
    async (provider, model, patch, expected) => {
      const aliases = { entry: "middle", middle: "wrong" };
      const modelIdNormalization = { providers: { candidate: { aliases } } };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "candidate", providers: ["candidate"], modelIdNormalization }],
      });
      const parts = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        prepared({
          cfg: { agents: { defaults: { model: { primary: "candidate/entry" } } } },
          provider,
          model,
          thinkingCatalog: [...catalog, modelLimits(provider, model, 128_000)],
          primaryModelLabelOverride: expected,
          sessionEntry: makeEntry({ sessionId: "typed-selection", updatedAt: 1, ...patch }),
        }),
      );
      expect(parts.text).toContain(`Model: ${expected}`);
      expect(parts.text).not.toContain("Model: candidate/wrong");
    },
  );

  it.each([
    { error: new SessionTranscriptProjectionUnavailableError("projection"), unavailable: true },
    { error: new SessionTranscriptStorageUnavailableError(), unavailable: true },
    { error: new Error("unexpected reader failure"), unavailable: false },
  ])("catches only unavailable terminal data ($error.name)", async ({ error, unavailable }) => {
    const readTail = vi
      .spyOn(transcriptTail, "readSessionTranscriptBoundedMessageTailPageAsync")
      .mockRejectedValue(error);
    const sessionEntry: InternalSessionEntry = {
      sessionId: "projection",
      updatedAt: 1,
      status: "done",
      lastRunId: "settled-run",
      fallbackNotice,
    };
    const result = prepared({ sessionEntry });
    if (unavailable) {
      expect((await result).text).not.toContain("Fallback:");
    } else {
      await expect(result).rejects.toBe(error);
    }
    expect(readTail).toHaveBeenCalledOnce();
  });
});

describe("buildStatusText lazy loader retry", () => {
  afterEach(() => {
    vi.doUnmock("./status-plugin-health.runtime.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function retryStatusParams(sessionId: string): Parameters<typeof buildStatusText>[0] {
    return statusParams({
      sessionEntry: { sessionId, updatedAt: 0 },
      primaryModelLabelOverride: "openai/gpt-5.4-mini",
    });
  }

  it("falls back on import failure and retries in the same module instance", async () => {
    vi.doMock("./status-plugin-health.runtime.js", async () => {
      throw new Error("Module load failure");
    });
    vi.resetModules();

    const { buildStatusText: firstLoadBuildStatusText } = await import("./status-text.js");
    const failed = await firstLoadBuildStatusText(retryStatusParams("retry-failure"));
    expect(failed).toContain("Plugins: health unavailable");

    vi.doMock("./status-plugin-health.runtime.js", () => ({
      collectRuntimePluginHealthSnapshot: () => ({
        plugins: [],
        diagnostics: [],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [],
        channelPluginFailures: [],
      }),
    }));

    const recovered = await firstLoadBuildStatusText(retryStatusParams("retry-recovery"));
    expect(recovered).not.toContain("Plugins: health unavailable");
  });
});

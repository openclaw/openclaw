import type { StatementSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
import { buildStatusReplyParts } from "./status-text.js";

vi.mock(import("../infra/session-cost-usage.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSessionCostSummariesFromCache: async () => ({
      summaries: [null],
      cacheStatus: { status: "partial", cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
    }),
  };
});

type StatusTextParams = Parameters<typeof buildStatusReplyParts>[0];
const selected = { provider: "deepseek", model: "deepseek-v4-flash" };
const active = { provider: "fallback", model: "small-model" };
const modelLimits = (provider: string, id: string, contextWindow: number) => ({
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

describe("buildStatusText prepared context windows", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "status-model" });
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
  const catalog = [
    modelLimits(selected.provider, selected.model, 1_000_000),
    modelLimits(active.provider, active.model, 128_000),
    modelLimits("openrouter", "deepseek/deepseek-v4-flash", 1_000_000),
  ];

  async function renderPreparedStatus(overrides: Partial<StatusTextParams> = {}) {
    return await buildStatusReplyParts({
      cfg: {},
      sessionEntry: { sessionId: "prepared-context", updatedAt: 0, ...tokenUsage },
      sessionKey: "agent:main:main",
      statusChannel: "mobilechat",
      ...selected,
      thinkingCatalog: catalog,
      resolvedHarness: "openclaw",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      pluginHealthLineOverride: "Plugins: test",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
      includeTranscriptUsage: false,
      ...overrides,
    });
  }

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
    await appendTranscriptMessage(target, {
      message: {
        role: "assistant",
        content: "x".repeat(300_000),
        usage: { input: 10, output: 2, totalTokens: 12 },
      },
    });
    await waitForSessionTranscriptProjection(target);
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const reads: string[] = [];
    const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(read, receiver: StatementSync, args) {
            if (
              /\b(?:transcript_events|session_transcript_active_events|transcript_event_identities)\b/iu.test(
                receiver.sourceSQL,
              )
            ) {
              reads.push(receiver.sourceSQL);
            }
            return Reflect.apply(read, receiver, args);
          },
        }),
      );
    });
    const render = () =>
      renderPreparedStatus({
        sessionEntry: entry,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        includeTranscriptUsage: true,
      });
    setRuntimeConfigSnapshot({});
    try {
      const first = await render();
      // The newest message still contributes usage when its body exceeds the byte budget.
      expect(first.text).toContain("Tokens: 10 in / 2 out");
      expect(reads).toEqual([]);

      await appendTranscriptMessage(target, {
        message: {
          role: "assistant",
          content: "New usage",
          usage: { input: 30, output: 4, totalTokens: 34 },
        },
      });
      await waitForSessionTranscriptProjection(target);
      reads.length = 0;
      const latest = await render();
      expect(latest.text).toContain("Tokens: 30 in / 4 out");
      expect(reads).toEqual([]);

      const committedEntry = {
        ...entry,
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
        inputTokens: 60,
        outputTokens: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      } satisfies InternalSessionEntry;
      await replaceSessionEntry(target, committedEntry);
      readUsage.mockClear();
      const committed = await renderPreparedStatus({
        sessionEntry: committedEntry,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        includeTranscriptUsage: true,
      });
      expect(committed.text).toContain("Tokens: 60 in / 6 out");
      expect(readUsage).not.toHaveBeenCalled();
    } finally {
      observers.forEach((observer) => observer.mockRestore());
    }
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
        const parts = await renderPreparedStatus({
          provider,
          model,
          resolvedHarness: resolvedHarness ?? "openclaw",
          contextTokens: 200_000,
          thinkingCatalog: [
            {
              provider,
              id: model,
              nativeRuntime,
              contextWindow: window,
              contextTokens: window,
            },
          ],
        });

        expect(parts.text).toContain(`Context: ${expected}`);
        const table = parts.presentation.blocks.find((block) => block.type === "table");
        expect(table?.type === "table" ? table.rows : []).toContainEqual([
          "📚 Context",
          expect.stringContaining(expected),
        ]);
      } finally {
        cacheMaps.forEach((cache, index) => {
          const value = previous[index];
          if (value === undefined) {
            cache.delete(key);
          } else {
            cache.set(key, value);
          }
        });
      }
    },
  );

  it("renders the agent thinking default ahead of model and global defaults", async () => {
    const parts = await renderPreparedStatus({
      cfg: {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: { "fixture/reasoning-model": { params: { thinking: "high" } } },
          },
          entries: {
            main: {
              thinkingDefault: "minimal",
              models: { "fixture/reasoning-model": { params: { thinking: "high" } } },
            },
          },
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
      "selected model auto with a different active fallback cutoff",
      "auto",
      { activeFallback: true },
      "auto (120 sec)",
    ],
    ["session off overrides model on", true, { sessionFast: false }, "off"],
    ["prepared off overrides model on", true, { preparedFast: false }, "off"],
  ] as const)("renders fast mode for %s", async (_name, configured, scenario, expected) => {
    const parts = await renderPreparedStatus({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/base-model": {
                params: { fastMode: !configured, fastAutoOnSeconds: 30 },
              },
              "anthropic/selected-model": {
                params: { fastMode: configured, fastAutoOnSeconds: 120 },
              },
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "status-fast-selected",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "selected-model",
        ...("sessionFast" in scenario ? { fastMode: scenario.sessionFast } : {}),
        ...("activeFallback" in scenario
          ? {
              modelProvider: "openai",
              model: "base-model",
              fallbackNotice: {
                kind: "active" as const,
                selectedModel: "anthropic/selected-model",
                activeModel: "openai/base-model",
                reason: "provider unavailable",
              },
            }
          : {}),
      },
      resolvedFastMode: "preparedFast" in scenario ? scenario.preparedFast : undefined,
      provider: "openai",
      model: "base-model",
    });

    expect(parts.text).toContain(`fast ${expected}`);
  });

  async function renderTerminalFallback(
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
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
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
        const parts = await renderPreparedStatus({
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
    ["stale runtime telemetry", {}],
    [
      "literal provider-local model",
      {
        status: { provider: "MiXeD", model: "Vendor/Model:opaque" },
        entry: { fallbackNotice: notice({ selectedModel: "mixed/Vendor/Model:opaque" }) },
      },
    ],
    [
      "legacy embedded provider",
      {
        entry: {
          modelOverride: "MiXeD/Model:Case",
          fallbackNotice: notice({ selectedModel: "MiXeD/Model:Case" }),
        },
      },
    ],
  ] satisfies Array<[string, Parameters<typeof renderTerminalFallback>[0]]>)(
    "projects a settled terminal fallback over %s without relabeling the entry",
    async (_name, params) => {
      const parts = await renderTerminalFallback(params);
      expectFallback(parts);
      expect(parts.text).not.toContain("45k/1.0m");
      const table = parts.presentation.blocks.find((block) => block.type === "table");
      expect(table?.type === "table" ? table.rows : []).toContainEqual([
        "📚 Context",
        expect.stringContaining("45k/128k"),
      ]);
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
    [
      "unmatched active notice",
      {
        entry: { fallbackNotice: notice({ activeModel: "fallback/other-model" }) },
      },
    ],
  ] satisfies Array<[string, Parameters<typeof renderTerminalFallback>[0]]>)(
    "does not project terminal fallback for %s",
    async (_name, params) => {
      const parts = await renderTerminalFallback(params);
      expect(parts.text).not.toContain("Fallback: fallback/small-model");
      expect(parts.text).toContain("Context: 45k/1.0m");
    },
  );

  it("skips terminal transcript access for a stale selected notice", async () => {
    const readTail = vi.spyOn(transcriptTail, "readSessionTranscriptBoundedMessageTailPageAsync");
    const parts = await renderTerminalFallback({
      entry: { fallbackNotice: notice({ selectedModel: "deepseek/older-model" }) },
    });
    expect(parts.text).not.toContain("Fallback: fallback/small-model");
    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(readTail).not.toHaveBeenCalled();
  });

  it("uses the admitted effective cap for the terminal pair", async () => {
    const parts = await renderTerminalFallback({
      entry: { providerOverride: "deepseek", modelOverride: "deepseek-v4-flash" },
      status: {
        provider: "fallback",
        model: "small-model",
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
        modelProvider: "usage",
        model: "previous-model",
        inputTokens: 10,
        outputTokens: 2,
      });
    const parts = await renderTerminalFallback({
      entry: {
        modelProvider: undefined,
        model: undefined,
        fallbackNotice: notice({ activeModel, reason: "provider unavailable" }),
      },
      status: { includeTranscriptUsage: true },
    });
    expect(readUsage).toHaveBeenCalled();
    expect(parts.text).toContain(`Fallback: ${activeModel}`);
  });

  const budget: SessionContextBudgetStatus = {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 1,
    ...active,
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 64_000,
    contextTokenBudget: 128_000,
    promptBudgetBeforeReserve: 100_000,
    reserveTokens: 28_000,
    effectiveReserveTokens: 28_000,
    remainingPromptBudgetTokens: 36_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
    sessionId: "terminal-fallback",
  };
  it.each([
    ["matching budget", {}, true],
    ["selected model budget", { provider: "deepseek", model: "deepseek-v4-flash" }, false],
  ] satisfies Array<[string, Partial<SessionContextBudgetStatus>, boolean]>)(
    "projects only a %s owned by the terminal model",
    async (_name, patch, expected) => {
      const parts = await renderTerminalFallback({
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
    [
      "opaque empty provider",
      "",
      "Vendor/Model:opaque",
      { providerOverride: "" },
      "Vendor/Model:opaque",
    ],
    [
      "explicit override",
      "candidate",
      "entry",
      { providerOverride: "candidate", modelOverride: "middle" },
      "candidate/middle",
    ],
  ] satisfies Array<[string, string, string, Partial<InternalSessionEntry>, string]>)(
    "preserves typed selection for %s through the status owner",
    async (_name, provider, model, patch, expected) => {
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "candidate",
            providers: ["candidate"],
            modelIdNormalization: {
              providers: { candidate: { aliases: { entry: "middle", middle: "wrong" } } },
            },
          },
        ],
      });
      const parts = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        renderPreparedStatus({
          cfg: { agents: { defaults: { model: { primary: "candidate/entry" } } } },
          provider,
          model,
          thinkingCatalog: [...catalog, modelLimits(provider, model, 128_000)],
          primaryModelLabelOverride: expected,
          sessionEntry: { sessionId: "typed-selection", updatedAt: 1, ...patch },
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
    const result = renderPreparedStatus({ sessionEntry });
    if (unavailable) {
      expect((await result).text).not.toContain("Fallback:");
    } else {
      await expect(result).rejects.toBe(error);
    }
    expect(readTail).toHaveBeenCalledOnce();
  });
});

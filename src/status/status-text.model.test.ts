import type { StatementSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
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

vi.mock(import("../infra/session-cost-usage.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSessionCostSummariesFromCache: async () => ({
    summaries: [null],
    cacheStatus: { status: "partial", cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
  }),
}));

type StatusTextParams = Parameters<typeof buildStatusReplyParts>[0];
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
    const { db } = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
    const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
    const reads: string[] = [];
    for (const method of ["all", "get", "iterate", "run"] as const) {
      const original = prototype[method];
      vi.spyOn(prototype, method).mockImplementation(
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
    }
    const render = (sessionEntry: InternalSessionEntry = entry) =>
      renderPreparedStatus({
        sessionEntry,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        includeTranscriptUsage: true,
      });
    setRuntimeConfigSnapshot({});
    const first = await render();
    // The newest message still contributes usage when its body exceeds the byte budget.
    expect(first.text).toContain("Tokens: 10 in / 2 out");
    expect(reads).toEqual([]);

    await appendUsage("New usage", 30, 4);
    reads.length = 0;
    const latest = await render();
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
    const committed = await render(committedEntry);
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
        const parts = await renderPreparedStatus({
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
    const parts = await renderPreparedStatus({
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
      const parts = await renderPreparedStatus({
        cfg: { agents: { defaults: { models } } },
        sessionEntry: {
          sessionId: "status-fast-selected",
          updatedAt: 0,
          providerOverride: "anthropic",
          modelOverride: "selected-model",
          ...entry,
        },
        resolvedFastMode,
        provider: "openai",
        model: "base-model",
      });

      expect(parts.text).toContain(`fast ${expected}`);
    },
  );

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
        entry: noticeEntry({ selectedModel: "mixed/Vendor/Model:opaque" }),
      },
    ],
    [
      "legacy embedded provider",
      {
        entry: {
          modelOverride: "MiXeD/Model:Case",
          ...noticeEntry({ selectedModel: "MiXeD/Model:Case" }),
        },
      },
    ],
  ] satisfies Array<[string, Parameters<typeof renderTerminalFallback>[0]]>)(
    "projects a settled terminal fallback over %s without relabeling the entry",
    async (_name, params) => {
      const parts = await renderTerminalFallback(params);
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
      entry: noticeEntry({ selectedModel: "deepseek/older-model" }),
    });
    expect(parts.text).not.toContain("Fallback: fallback/small-model");
    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(readTail).not.toHaveBeenCalled();
  });

  it("uses the admitted effective cap for the terminal pair", async () => {
    const parts = await renderTerminalFallback({
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
      const aliases = { entry: "middle", middle: "wrong" };
      const modelIdNormalization = { providers: { candidate: { aliases } } };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "candidate", providers: ["candidate"], modelIdNormalization }],
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

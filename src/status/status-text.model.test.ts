import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import type { InternalSessionEntry, SessionContextBudgetStatus } from "../config/sessions/types.js";
import * as transcriptTail from "../gateway/session-transcript-readers.js";
import * as transcriptUsage from "../gateway/session-transcript-usage.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
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
      cacheStatus: {
        status: "partial",
        cachedFiles: 0,
        pendingFiles: 1,
        staleFiles: 0,
      },
    }),
  };
});

type StatusTextParams = Parameters<typeof buildStatusReplyParts>[0];

describe("buildStatusText prepared context windows", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "status-model" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    cliBackendsTesting.resetDepsForTest();
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
  const catalog = [
    {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
    },
    {
      provider: "fallback",
      id: "small-model",
      contextWindow: 128_000,
      contextTokens: 128_000,
    },
    {
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
    },
  ];

  async function renderPreparedStatus(overrides: Partial<StatusTextParams> = {}) {
    return await buildStatusReplyParts({
      cfg: {},
      sessionEntry: {
        sessionId: "prepared-context",
        updatedAt: 0,
        ...tokenUsage,
      },
      sessionKey: "agent:main:main",
      statusChannel: "mobilechat",
      provider: "deepseek",
      model: "deepseek-v4-flash",
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

  it.each([
    { name: "current discovered limits", window: 262_144, expected: "45k/262k" },
    { name: "unknown limits", window: undefined, expected: "45k/?" },
    {
      name: "another runtime's limits",
      window: 262_144,
      nativeRuntime: "other-runtime",
      expected: "45k/?",
    },
    {
      name: "API limits for a native runtime",
      window: 262_144,
      resolvedHarness: "fixture-native",
      expected: "45k/?",
    },
  ])("renders $name without reusing a stale cache or estimate", async (scenario) => {
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
        resolvedHarness: scenario.resolvedHarness ?? "openclaw",
        contextTokens: 200_000,
        thinkingCatalog: [
          {
            provider,
            id: model,
            nativeRuntime: scenario.nativeRuntime,
            contextWindow: scenario.window,
            contextTokens: scenario.window,
          },
        ],
      });

      expect(parts.text).toContain(`Context: ${scenario.expected}`);
      const table = parts.presentation.blocks.find((block) => block.type === "table");
      expect(table?.type === "table" ? table.rows : []).toContainEqual([
        "📚 Context",
        expect.stringContaining(scenario.expected),
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
  });

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
    {
      name: "selected model auto with a different active fallback cutoff",
      configured: "auto",
      activeFallback: true,
      expected: "auto (120 sec)",
    },
    {
      name: "session off overrides model on",
      configured: true,
      sessionFast: false,
      expected: "off",
    },
    {
      name: "prepared off overrides model on",
      configured: true,
      preparedFast: false,
      expected: "off",
    },
  ] as const)("renders fast mode for $name", async (scenario) => {
    const parts = await renderPreparedStatus({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/base-model": {
                params: { fastMode: !scenario.configured, fastAutoOnSeconds: 30 },
              },
              "anthropic/selected-model": {
                params: { fastMode: scenario.configured, fastAutoOnSeconds: 120 },
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

    expect(parts.text).toContain(`fast ${scenario.expected}`);
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
      append(
        attachSessionTranscriptRunId(
          {
            role: "assistant",
            provider: "fallback",
            model: "small-model",
            stopReason: "stop",
            content: [{ type: "text", text: "Synthetic response" }],
            ...params.message,
          },
          "settled-run",
        ),
      );
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
        entry: {
          fallbackNotice: {
            ...fallbackNotice,
            selectedModel: "mixed/Vendor/Model:opaque",
          },
        },
      },
    ],
    [
      "legacy embedded provider",
      {
        entry: {
          modelOverride: "MiXeD/Model:Case",
          fallbackNotice: {
            ...fallbackNotice,
            selectedModel: "MiXeD/Model:Case",
          },
        },
      },
    ],
  ] satisfies Array<[string, Parameters<typeof renderTerminalFallback>[0]]>)(
    "projects a settled terminal fallback over %s without relabeling the entry",
    async (_name, params) => {
      const parts = await renderTerminalFallback(params);
      expect(parts.text).toContain("Fallback: fallback/small-model");
      expect(parts.text).toContain("Context: 45k/128k");
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
        laterMessage: attachSessionTranscriptRunId(
          {
            role: "assistant",
            provider: "fallback",
            model: "small-model",
            stopReason: "stop",
            content: [{ type: "text", text: "Other run" }],
          },
          "other-run",
        ),
      },
    ],
    [
      "unmatched active notice",
      {
        entry: {
          fallbackNotice: {
            ...fallbackNotice,
            activeModel: "fallback/other-model",
          },
        },
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
      entry: {
        fallbackNotice: {
          ...fallbackNotice,
          selectedModel: "deepseek/older-model",
        },
      },
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
    expect(parts.text).toContain("Fallback: fallback/small-model");
    expect(parts.text).toContain("Context: 45k/96k");
  });

  it.each([
    ["accepted terminal pair", "fallback/small-model"],
    ["legacy usage fallback", "usage/previous-model"],
  ])("keeps %s through independent usage hydration", async (_name, notice) => {
    const readUsage = vi
      .spyOn(transcriptUsage, "readRecentSessionUsageFromTranscript")
      .mockReturnValue({
        modelProvider: "usage",
        model: "previous-model",
        inputTokens: 10,
        outputTokens: 2,
      });
    const parts = await renderTerminalFallback({
      entry: {
        modelProvider: undefined,
        model: undefined,
        fallbackNotice: {
          ...fallbackNotice,
          activeModel: notice,
          reason: "provider unavailable",
        },
      },
      status: { includeTranscriptUsage: true },
    });
    expect(readUsage).toHaveBeenCalled();
    expect(parts.text).toContain(`Fallback: ${notice}`);
  });

  const budget: SessionContextBudgetStatus = {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 1,
    provider: "fallback",
    model: "small-model",
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
          thinkingCatalog: [
            ...catalog,
            { provider, id: model, contextWindow: 128_000, contextTokens: 128_000 },
          ],
          primaryModelLabelOverride: expected,
          sessionEntry: { sessionId: "typed-selection", updatedAt: 1, ...patch },
        }),
      );
      expect(parts.text).toContain(`Model: ${expected}`);
      expect(parts.text).not.toContain("Model: candidate/wrong");
    },
  );

  it("does not turn the context overlay label into a new selected model", async () => {
    const parts = await renderPreparedStatus({ primaryModelLabelOverride: "fallback/small-model" });
    expect(parts.text).toContain("Model: deepseek/deepseek-v4-flash");
  });

  it("preserves a literal self-provider prefix in a prepared model ID", async () => {
    const sessionEntry: InternalSessionEntry = {
      sessionId: "selection-owner-control",
      updatedAt: 1,
    };
    const original = structuredClone(sessionEntry);
    const parts = await renderPreparedStatus({
      cfg: { agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } },
      provider: "custom",
      model: "custom/model",
      sessionEntry,
      resolvedThinkLevel: "off",
    });
    expect(parts.text).toContain("Model: custom/custom/model");
    expect(parts.text).not.toContain("Model: custom/model");
    const table = parts.presentation.blocks.find((block) => block.type === "table");
    expect(table?.type === "table" ? table.rows : []).toContainEqual([
      "🧠 Model",
      expect.stringContaining("custom/custom/model"),
    ]);
    expect(sessionEntry).toEqual(original);
  });

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

  it("renders a cold-cache prepared window in plain and rich status", async () => {
    const parts = await renderPreparedStatus();
    const table = parts.presentation.blocks.find((block) => block.type === "table");

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/200k");
    expect(table?.type === "table" ? table.rows : []).toContainEqual([
      "📚 Context",
      expect.stringContaining("45k/1.0m"),
    ]);
  });

  it("keeps the selected prepared window over stale active model state", async () => {
    const parts = await renderPreparedStatus({
      sessionEntry: {
        sessionId: "selected-prepared-context",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "user",
        modelProvider: "fallback",
        model: "small-model",
        ...tokenUsage,
      },
    });

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/128k");
  });

  it("uses the active prepared window for an established fallback", async () => {
    const parts = await renderPreparedStatus({
      sessionEntry: {
        sessionId: "active-prepared-context",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelProvider: "fallback",
        model: "small-model",
        fallbackNotice: { ...fallbackNotice, reason: "provider unavailable" },
        ...tokenUsage,
      },
    });

    expect(parts.text).toContain("Context: 45k/128k");
    expect(parts.text).not.toContain("Context: 45k/1.0m");
  });

  it("keeps Anthropic authored caps below the prepared Claude CLI window", async () => {
    // Supply runtime alias metadata while exercising the authored context cap.
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
          bundleMcp: true,
        },
      ],
    });
    const parts = await renderPreparedStatus({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      resolvedHarness: "claude-cli",
      sessionEntry: {
        sessionId: "claude-cli-authored-cap",
        updatedAt: 0,
        modelProvider: "claude-cli",
        model: "claude-haiku-4-5",
        agentHarnessId: "claude-cli",
        contextTokens: 256_000,
        contextTokensSource: "resolved",
        ...tokenUsage,
      },
      thinkingCatalog: [
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
      ],
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.test",
              models: [
                {
                  id: "claude-haiku-4-5",
                  name: "Claude Haiku 4.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  contextTokens: 256_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
    });

    expect(parts.text).toContain("Context: 45k/256k");
    expect(parts.text).not.toContain("Context: 45k/1.0m");
  });

  it("matches namespaced prepared model IDs without stripping them", async () => {
    const parts = await renderPreparedStatus({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      thinkingCatalog: [
        ...catalog,
        {
          provider: "openrouter",
          id: "deepseek-v4-flash",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          contextTokens: 128_000,
        },
      ],
    });

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/128k");
  });
});

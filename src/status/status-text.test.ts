import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import * as preparedCatalog from "../agents/prepared-model-catalog.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as Entry,
} from "../config/sessions/types.js";
import * as transcriptTail from "../gateway/session-transcript-readers.js";
import * as transcriptUsage from "../gateway/session-transcript-usage.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import * as providerPolicySurface from "../plugins/provider-policy-surface.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { buildStatusText, buildStatusReplyParts } from "./status-text.js";

const mocks = vi.hoisted(() => ({ cost: vi.fn(), usage: vi.fn() }));
vi.mock(import("../infra/session-cost-usage.js"), async (original) => ({
  ...(await original()),
  loadSessionCostSummariesFromCache: mocks.cost,
}));
vi.mock(import("../infra/provider-usage.js"), async (original) => ({
  ...(await original()),
  loadProviderUsageSummary: mocks.usage,
}));

type Params = Parameters<typeof buildStatusText>[0];
const entry = (patch: Partial<Entry> = {}): Entry => ({
  sessionId: "status",
  updatedAt: 0,
  ...patch,
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
const tokenUsage = {
  totalTokens: 45_000,
  totalTokensFresh: true,
  totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
} satisfies Partial<Entry>;
const fallback = "fallback/small-model";
const fallbackNotice = {
  kind: "active",
  selectedModel: "deepseek/deepseek-v4-flash",
  activeModel: fallback,
} satisfies NonNullable<Entry["fallbackNotice"]>;
const notice = (patch: Partial<NonNullable<Entry["fallbackNotice"]>>) => ({
  fallbackNotice: { ...fallbackNotice, ...patch },
});
const catalog = [
  modelLimits(selected.provider, selected.model, 1_000_000),
  modelLimits(active.provider, active.model, 128_000),
];
const oauth = { modelAuthOverride: "oauth", activeModelAuthOverride: "oauth" };
const usageSummary = (enabled = true) => ({
  updatedAt: Date.now(),
  providers: enabled
    ? [{ provider: "openai", displayName: "Codex", windows: [{ label: "5h", usedPercent: 25 }] }]
    : [],
});
const params = (patch: Partial<Params> = {}): Params => ({
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
  pluginHealthLineOverride: "Plugins: test",
  ...patch,
});
const render = (patch: Partial<Params>) => buildStatusText(params(patch));
const prepared = (patch: Partial<Params> = {}) =>
  buildStatusReplyParts(
    params({
      sessionEntry: entry({ sessionId: "prepared-context", ...tokenUsage }),
      ...selected,
      thinkingCatalog: catalog,
      ...patch,
    }),
  );
async function expectText(
  result: string | Promise<string | Awaited<ReturnType<typeof prepared>>>,
  contains: string[],
  absent: string[] = [],
) {
  const rendered = await result;
  const text = typeof rendered === "string" ? rendered : rendered.text;
  for (const value of contains) {
    expect(text).toContain(value);
  }
  for (const value of absent) {
    expect(text).not.toContain(value);
  }
}
describe("prepared status", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "status-text" });
    mocks.cost
      .mockReset()
      .mockResolvedValue({ summaries: [null], cacheStatus: { status: "partial" } });
    const actual = await vi.importActual<typeof import("../infra/provider-usage.js")>(
      "../infra/provider-usage.js",
    );
    mocks.usage.mockReset().mockImplementation(actual.loadProviderUsageSummary);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
    await state.cleanup();
  });

  it("bounds catalog identity work per status reply and renews changed provider policies", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      provider: "fixture",
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    const routeVariants = entries.map((row) => ({
      ...row,
      id: `vendor/${row.id}`,
      nativeRuntime: "fixture-native",
      contextWindow: 128_000,
      contextTokens: 128_000,
    }));
    const cfg = {};
    const owner = createModelRuntimeChoiceOwnerFixture(cfg, undefined, {
      modelCatalog: { entries, routeVariants },
    });
    vi.spyOn(preparedCatalog, "getPreparedModelCatalogOwnerSnapshot").mockReturnValue(owner);
    const normalize = vi.fn(({ modelId }: { modelId: string }) =>
      modelId.replace(/^vendor\//u, ""),
    );
    const policy = vi
      .spyOn(providerPolicySurface, "resolveDirectBundledProviderPolicySurface")
      .mockImplementation((provider) =>
        provider === "fixture" ? { normalizeModelCatalogId: normalize } : null,
      );
    const reply = () =>
      prepared({
        cfg,
        provider: "fixture",
        model: "model-0",
        resolvedHarness: "fixture-native",
      });
    await expectText(reply(), ["Context: 45k/128k"]);
    // Include all status consumers, with headroom for the selected/active model lookups.
    expect(normalize.mock.calls.length).toBeLessThan(entries.length * 10);
    policy.mockImplementation((provider) =>
      provider === "fixture"
        ? {
            normalizeModelCatalogId: ({ modelId }) => modelId,
          }
        : null,
    );
    await expectText(reply(), ["Context: 45k/?"], ["45k/128k"]);
  });

  it.each([
    [undefined, undefined, "off", "channels.telegram.richMessages=true"],
    [true, undefined, "on", "sendRichMessage enabled"],
    [true, "session", "off", "enable richMessages for this Telegram account"],
    [true, "request", "off", "enable richMessages for this Telegram account"],
  ] as const)(
    "renders Telegram features (%s, account=%s)",
    async (richMessages, account, enabled, hint) => {
      const telegram = {
        richMessages,
        ...(account ? { accounts: { Work: { richMessages: false } } } : {}),
      };
      await expectText(
        render({
          cfg: { channels: { telegram } },
          statusChannel: "telegram",
          sessionEntry: entry({
            delivery:
              account === "session"
                ? normalizeSessionDeliveryState({
                    context: { channel: "telegram", accountId: "work" },
                  })
                : undefined,
          }),
          statusAccountId: account === "request" ? "work" : undefined,
        }),
        [`Telegram rich messages: ${enabled}`, hint],
      );
    },
  );

  it("shows the selected global agent's children instead of the default agent's", async () => {
    const cfg: Params["cfg"] = {
      agents: { defaults: { systemAgent: { agentId: "ops" } }, entries: { research: {}, ops: {} } },
      session: { scope: "global" },
    };
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(cfg);
    try {
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
      await expectText(
        render({ cfg, sessionKey: "global", agentId: "research" }),
        ["🤖 Subagents: 1 active", "research status worker"],
        ["ops status worker"],
      );
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
    }
  });

  it.each(["codex", "openclaw"] as const)("respects the %s usage binding", async (harness) => {
    mocks.usage.mockImplementation(async ({ providers, auth }) =>
      usageSummary(
        providers[0] === "openai" &&
          auth?.[0]?.provider === "openai" &&
          auth[0].hookProvider === "codex",
      ),
    );
    const text = await render({
      ...oauth,
      sessionEntry: entry({ agentRuntimeOverride: "openclaw", agentHarnessId: harness }),
    });
    if (harness === "codex") {
      expect(text).toContain("📊 Usage: 5h 75% left");
    } else {
      expect(text).not.toContain("📊 Usage:");
      expect(mocks.usage.mock.calls[0]?.[0].auth).toBeUndefined();
    }
  });

  it.each([
    ["fresh", 0, "💵 $1.23 · 456k tok (today)"],
    [
      "fresh",
      12,
      "💵 missing cost: 12 (openai/gpt-5.6-sol 10, openai-codex/gpt-5.5 2) · 456k tok (today)",
    ],
    ["stale", 0, undefined],
    ["failed", 0, undefined],
  ] as const)(
    "renders %s cost with %i missing prices",
    async (status, missingCostEntries, expected) => {
      mocks.usage.mockResolvedValue(usageSummary());
      if (status === "failed") {
        mocks.cost.mockRejectedValue(new Error("cache unavailable"));
      } else {
        mocks.cost.mockResolvedValue({
          cacheStatus: { status },
          summaries: [
            {
              totalTokens: 456_000,
              totalCost: 1.23,
              missingCostEntries,
              ...(missingCostEntries
                ? { missingCostByModel: { "openai/gpt-5.6-sol": 10, "openai-codex/gpt-5.5": 2 } }
                : {}),
            },
          ],
        });
      }
      const text = await render({
        ...oauth,
        sessionEntry: entry({ sessionId: "cost-session" }),
      });
      await expectText(
        text,
        ["📊 Usage: 5h 75% left", ...(expected ? [expected] : [])],
        expected ? [] : ["💵"],
      );
    },
  );

  it.each([
    { reasoning: true, expected: "think high" },
    { reasoning: false, expected: "think off (requested high; clamped)" },
  ])("renders Ollama thinking (reasoning=$reasoning)", async ({ reasoning, expected }) => {
    await expectText(
      render({
        provider: "ollama",
        model: "glm-5.2:cloud",
        thinkingCatalog: [{ provider: "ollama", id: "glm-5.2:cloud", reasoning }],
        resolvedThinkLevel: "high",
      }),
      [expected],
    );
  });

  it("uses the prepared fast-mode override ahead of model config", async () => {
    await expectText(
      prepared({
        provider: "openai",
        model: "base-model",
        resolvedFastMode: false,
        sessionEntry: entry({ providerOverride: "anthropic", modelOverride: "selected-model" }),
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/base-model": { params: { fastMode: false } },
                "anthropic/selected-model": { params: { fastMode: true } },
              },
            },
          },
        },
      }),
      ["fast off"],
    );
  });

  it("uses the latest transcript until complete committed usage is available", async () => {
    const target = {
      agentId: "main",
      sessionId: "status-worker-usage",
      sessionKey: "agent:main:status-worker-usage",
      storePath: state.statePath("status.sqlite"),
    };
    const sessionEntry = entry({ sessionId: target.sessionId });
    const readUsage = vi.spyOn(transcriptUsage, "readRecentSessionUsageFromTranscriptAsync");
    await replaceSessionEntry(target, sessionEntry);
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
    const renderUsage = (value = sessionEntry) =>
      prepared({
        sessionEntry: value,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        includeTranscriptUsage: true,
      });
    setRuntimeConfigSnapshot({});
    expect((await renderUsage()).text).toContain("Tokens: 10 in / 2 out");
    expect(reads).toEqual([]);
    await appendUsage("New usage", 30, 4);
    reads.length = 0;
    expect((await renderUsage()).text).toContain("Tokens: 30 in / 4 out");
    expect(reads).toEqual([]);
    const committed = {
      ...sessionEntry,
      ...modelEntry(selected),
      ...tokenUsage,
      inputTokens: 60,
      outputTokens: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
    } satisfies Entry;
    await replaceSessionEntry(target, committed);
    readUsage.mockClear();
    expect((await renderUsage(committed)).text).toContain("Tokens: 60 in / 6 out");
    expect(readUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["current discovered limits", 262_144, "45k/262k", undefined, undefined],
    ["unknown limits", undefined, "45k/?", undefined, undefined],
    ["another runtime's limits", 262_144, "45k/?", "other-runtime", undefined],
    ["API limits for a native runtime", 262_144, "45k/?", undefined, "fixture-native"],
  ] as const)(
    "renders %s without stale estimates",
    async (_name, window, expected, nativeRuntime, harness) => {
      const provider = "ollama",
        model = "qwen3:8b";
      await expectText(
        prepared({
          provider,
          model,
          resolvedHarness: harness ?? "openclaw",
          contextTokens: 200_000,
          thinkingCatalog: [{ ...modelLimits(provider, model, window), nativeRuntime }],
        }),
        [`Context: ${expected}`],
      );
    },
  );

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
  type Terminal = {
    entry?: Partial<Entry>;
    live?: boolean;
    message?: Record<string, unknown>;
    laterMessage?: Record<string, unknown>;
    status?: Partial<Params>;
  };
  async function terminal(patch: Terminal = {}) {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionId: "terminal-fallback",
      sessionKey: "agent:main:main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    replaceSessionEntrySync(
      scope,
      entry({
        sessionId: scope.sessionId,
        status: "done",
        lastRunId: "settled-run",
        ...modelEntry(selected),
        agentHarnessId: "openclaw",
        contextTokens: 1_000_000,
        contextTokensSource: "runtime",
        ...tokenUsage,
        ...notice({ reason: "provider unavailable" }),
        ...patch.entry,
      }),
    );
    for (const message of [
      assistant(patch.message),
      ...(patch.laterMessage ? [patch.laterMessage] : []),
    ]) {
      expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
    }
    const original = loadSessionEntryReadOnly(scope),
      runId = "current-live-run";
    if (patch.live) {
      registerAgentRunContext(runId, { ...scope, projectSessionActive: true });
    }
    try {
      const parts = await prepared({
        sessionEntry: original,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        ...patch.status,
      });
      expect(loadSessionEntryReadOnly(scope)).toEqual(original);
      return parts;
    } finally {
      if (patch.live) {
        clearAgentRunContext(runId);
      }
    }
  }

  it.each<[string, string, Partial<Entry>, string]>([
    [selected.provider, selected.model, {}, "deepseek/deepseek-v4-flash"],
    ["MiXeD", "Vendor/Model:opaque", {}, "mixed/Vendor/Model:opaque"],
    [selected.provider, selected.model, { modelOverride: "MiXeD/Model:Case" }, "MiXeD/Model:Case"],
    ["", "Vendor/Model:opaque", { providerOverride: "" }, "Vendor/Model:opaque"],
  ])("retains %s/%s and its settled fallback", async (provider, model, patch, label) => {
    const parts = await terminal({
      entry: { ...patch, ...notice({ selectedModel: label }) },
      status: {
        provider,
        model,
        primaryModelLabelOverride: label,
        thinkingCatalog: [...catalog, modelLimits(provider, model, 128_000)],
      },
    });
    await expectText(parts.text, [`Model: ${label}`, `Fallback: ${fallback}`], ["45k/1.0m"]);
    expect(parts.text).toContain("Context: 45k/128k");
  });

  it.each<[string, Terminal]>([
    ["running session", { live: true }],
    ["missing run", { entry: { lastRunId: undefined } }],
    ["failed assistant", { message: { stopReason: "error" } }],
    ["hidden assistant", { message: { content: [] } }],
    ["undisplayed assistant", { message: { display: false } }],
    ["oversized tail", { message: { content: [{ type: "text", text: "x".repeat(300_000) }] } }],
    ["later user", { laterMessage: { role: "user", content: "New turn" } }],
    ["later run", { laterMessage: assistant({}, "other-run") }],
    ["unmatched active notice", { entry: notice({ activeModel: "fallback/other-model" }) }],
    ["stale selected notice", { entry: notice({ selectedModel: "deepseek/older-model" }) }],
  ])("does not project terminal fallback for %s", async (_name, patch) => {
    await expectText(terminal(patch), ["Context: 45k/1.0m"], [`Fallback: ${fallback}`]);
  });

  it.each([false, true])("caps the terminal window (choice=%s)", async (choice) => {
    const activeLimits = {
      ...catalog[1]!,
      contextTokens: 96_000,
      contextWindows: choice ? [{ id: "50k", label: "50K", contextWindow: 50_000 }] : [],
      contextWindowDefault: choice ? "50k" : undefined,
    };
    await expectText(
      terminal({
        entry: { providerOverride: selected.provider, modelOverride: selected.model },
        status: { ...active, thinkingCatalog: [catalog[0]!, activeLimits] },
      }),
      [`Fallback: ${fallback}`, `Context: 45k/${choice ? "50k" : "96k"}`],
    );
  });

  it.each([fallback, "usage/previous-model"])(
    "keeps %s through independent usage hydration",
    async (activeModel) => {
      vi.spyOn(transcriptUsage, "readRecentSessionUsageFromTranscriptAsync").mockResolvedValue({
        ...modelEntry({ provider: "usage", model: "previous-model" }),
        inputTokens: 10,
        outputTokens: 2,
      });
      await expectText(
        terminal({
          entry: {
            modelProvider: undefined,
            model: undefined,
            ...notice({ activeModel, reason: "provider unavailable" }),
          },
          status: { includeTranscriptUsage: true },
        }),
        [`Fallback: ${activeModel}`],
      );
    },
  );

  it.each([true, false])("matches terminal budget ownership (%s)", async (matching) => {
    const contextBudgetStatus = contextBudgetStatusFixture({
      ...(matching ? active : selected),
      estimatedPromptTokens: 64_000,
      contextTokenBudget: 128_000,
      sessionId: "terminal-fallback",
    });
    const parts = await terminal({ entry: { totalTokens: undefined, contextBudgetStatus } });
    await expectText(parts.text, [`Fallback: ${fallback}`, "128k"]);
    expect(parts.text.includes("64k")).toBe(matching);
  });

  it.each([
    { error: new SessionTranscriptProjectionUnavailableError("projection"), unavailable: true },
    { error: new SessionTranscriptStorageUnavailableError(), unavailable: true },
    { error: new Error("unexpected reader failure"), unavailable: false },
  ])("catches only unavailable terminal data ($error.name)", async ({ error, unavailable }) => {
    vi.spyOn(transcriptTail, "readSessionTranscriptBoundedMessageTailPageAsync").mockRejectedValue(
      error,
    );
    const result = prepared({
      sessionEntry: entry({
        sessionId: "projection",
        updatedAt: 1,
        status: "done",
        lastRunId: "settled-run",
        fallbackNotice,
      }),
    });
    if (unavailable) {
      expect((await result).text).not.toContain("Fallback:");
    } else {
      await expect(result).rejects.toBe(error);
    }
  });
});

it("falls back on import failure and retries in the same module instance", async () => {
  const input = params({ sessionEntry: entry({ sessionId: "retry" }) });
  delete input.pluginHealthLineOverride;
  vi.doMock("./status-plugin-health.runtime.js", async () => {
    throw new Error("Module load failure");
  });
  vi.resetModules();
  try {
    const { buildStatusText: build } = await import("./status-text.js");
    expect(await build(input)).toContain("Plugins: health unavailable");
    vi.doMock("./status-plugin-health.runtime.js", () => ({
      collectRuntimePluginHealthSnapshot: () => ({
        plugins: [],
        diagnostics: [],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [],
        channelPluginFailures: [],
      }),
    }));
    expect(await build(input)).not.toContain("Plugins: health unavailable");
  } finally {
    vi.doUnmock("./status-plugin-health.runtime.js");
    vi.resetModules();
    vi.restoreAllMocks();
  }
});

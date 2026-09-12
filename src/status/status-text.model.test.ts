import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as transcriptTail from "../config/sessions/session-accessor.sqlite-active-events.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import type { InternalSessionEntry, SessionContextBudgetStatus } from "../config/sessions/types.js";
import * as transcriptUsage from "../gateway/session-transcript-readers.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { buildStatusReplyParts } from "./status-text.js";

type StatusTextParams = Parameters<typeof buildStatusReplyParts>[0];

describe("buildStatusText prepared context windows", () => {
  afterEach(() => cliBackendsTesting.resetDepsForTest());
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

  async function renderPreparedStatus(
    overrides: Partial<Parameters<typeof buildStatusReplyParts>[0]> = {},
  ) {
    return await buildStatusReplyParts({
      cfg: {},
      sessionEntry: {
        sessionId: "prepared-context",
        updatedAt: 0,
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
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
      taskLineOverride: "",
      skipDefaultTaskLookup: true,
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
      includeTranscriptUsage: false,
      ...overrides,
    });
  }

  async function renderTerminalFallback(
    params: {
      entry?: Partial<InternalSessionEntry>;
      message?: Record<string, unknown>;
      laterMessage?: Record<string, unknown>;
      status?: Partial<Parameters<typeof buildStatusReplyParts>[0]>;
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
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        fallbackNotice: {
          kind: "active",
          selectedModel: "deepseek/deepseek-v4-flash",
          activeModel: "fallback/small-model",
          reason: "provider unavailable",
        },
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
      const parts = await renderPreparedStatus({
        sessionEntry: original,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        contextTokens: 1_000_000,
        ...params.status,
      });
      expect(loadSessionEntryReadOnly(scope)).toEqual(original);
      return parts;
    });
  }

  it.each([
    ["stale runtime telemetry", {}],
    ["stale resolved context", { contextTokensSource: "resolved-v1" }],
    ["absent runtime model", { modelProvider: undefined, model: undefined }],
  ] satisfies Array<[string, Partial<InternalSessionEntry>]>)(
    "projects a settled terminal fallback over %s without relabeling the entry",
    async (_name, entry) => {
      const parts = await renderTerminalFallback({ entry });
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
    ["running session", { entry: { status: "running" } }],
    ["failed session", { entry: { status: "failed" } }],
    ["killed session", { entry: { status: "killed" } }],
    ["timed-out session", { entry: { status: "timeout" } }],
    ["missing run", { entry: { lastRunId: undefined } }],
    ["other run", { entry: { lastRunId: "other-run" } }],
    ["failed assistant", { message: { stopReason: "error" } }],
    ["hidden assistant", { message: { content: [] } }],
    ["undisplayed assistant", { message: { display: false } }],
    ["oversized tail", { message: { content: [{ type: "text", text: "x".repeat(300_000) }] } }],
    ["later user", { laterMessage: { role: "user", content: "New turn" } }],
    ["later tool", { laterMessage: { role: "toolResult", toolCallId: "later", content: [] } }],
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
      "stale selected notice",
      {
        entry: {
          fallbackNotice: {
            kind: "active",
            selectedModel: "deepseek/older-model",
            activeModel: "fallback/small-model",
          },
        },
      },
    ],
    [
      "unmatched active notice",
      {
        entry: {
          fallbackNotice: {
            kind: "active",
            selectedModel: "deepseek/deepseek-v4-flash",
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

  it("retains the incoming prepared cap when it already belongs to the terminal pair", async () => {
    const parts = await renderTerminalFallback({
      entry: { providerOverride: "deepseek", modelOverride: "deepseek-v4-flash" },
      status: {
        provider: "fallback",
        model: "small-model",
        contextTokens: 96_000,
        thinkingCatalog: catalog.map(({ provider, id, contextWindow }) => ({
          provider,
          id,
          contextWindow,
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
    try {
      const parts = await renderTerminalFallback({
        entry: {
          modelProvider: undefined,
          model: undefined,
          fallbackNotice: {
            kind: "active",
            selectedModel: "deepseek/deepseek-v4-flash",
            activeModel: notice,
            reason: "provider unavailable",
          },
        },
        status: { includeTranscriptUsage: true },
      });
      expect(readUsage).toHaveBeenCalled();
      expect(parts.text).toContain(`Fallback: ${notice}`);
    } finally {
      readUsage.mockRestore();
    }
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
    ["matching budget", {}, false, true],
    ["selected model budget", { provider: "deepseek", model: "deepseek-v4-flash" }, false, false],
    ["other session budget", { sessionId: "other-session" }, false, false],
    ["other cap budget", { contextTokenBudget: 1_000_000 }, false, false],
    ["pending switch budget", {}, true, false],
  ] satisfies Array<[string, Partial<SessionContextBudgetStatus>, boolean, boolean]>)(
    "projects only a %s owned by the terminal model",
    async (_name, patch, pending, expected) => {
      const parts = await renderTerminalFallback({
        entry: {
          totalTokens: undefined,
          contextBudgetStatus: { ...budget, ...patch },
          liveModelSwitchPending: pending,
        },
      });
      expect(parts.text).toContain("Fallback: fallback/small-model");
      expect(parts.text.includes("64k")).toBe(expected);
      expect(parts.text).toContain("128k");
    },
  );

  it.each([
    ["prepared alias", "candidate", "middle", {}, "candidate/middle"],
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
    [
      "legacy explicit override",
      "candidate",
      "entry",
      { modelOverride: "fallback/small-model" },
      "fallback/small-model",
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

  it.each([
    {
      name: "configured CLI default with absent session model fields",
      cfg: { agents: { defaults: { model: "claude-cli/opus" } } },
      expectedModel: "claude-cli/opus",
    },
    {
      name: "canonical default with absent agent configuration",
      cfg: {},
      expectedModel: "openai/gpt-5.6-sol",
    },
    {
      name: "literal self-provider prefix in a prepared model ID",
      cfg: { agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } },
      input: { provider: "custom", model: "custom/model" },
      expectedModel: "custom/custom/model",
      absent: ["Model: custom/model"],
    },
    {
      name: "manual selection that remains pending on an active session",
      cfg: { agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } },
      input: { provider: "deepseek", model: "deepseek-v4-flash" },
      entry: {
        status: "running",
        providerOverride: "fallback",
        modelOverride: "small-model",
        modelOverrideSource: "user",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
        liveModelSwitchPending: true,
      },
      expectedModel: "fallback/small-model",
      expected: ["live switch pending", "pinned session"],
      absent: ["Fallback:", "auto fallback"],
    },
    {
      name: "configured subagent selection with matching automatic origin",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { model: "deepseek/deepseek-v4-flash" },
          entries: { worker: { subagents: { model: "fallback/small-model" } } },
        },
      },
      agentId: "worker",
      sessionKey: "agent:worker:subagent:configured",
      input: { provider: "deepseek", model: "deepseek-v4-flash" },
      entry: {
        providerOverride: "fallback",
        modelOverride: "small-model",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "fallback",
        modelOverrideFallbackOriginModel: "small-model",
      },
      expectedModel: "fallback/small-model",
      absent: ["auto fallback", "check provider", "pinned session"],
    },
  ] satisfies Array<{
    name: string;
    cfg: StatusTextParams["cfg"];
    agentId?: string;
    sessionKey?: string;
    input?: Pick<StatusTextParams, "provider" | "model">;
    entry?: Partial<InternalSessionEntry>;
    expectedModel: string;
    expected?: string[];
    absent?: string[];
  }>)("preserves $name through the actual status owner", async (control) => {
    const agentId = control.agentId ?? "main";
    const sessionEntry: InternalSessionEntry = {
      sessionId: "selection-owner-control",
      updatedAt: 1,
      ...control.entry,
    };
    const original = structuredClone(sessionEntry);
    // Defaults use the real production selector; other rows carry prepared caller facts.
    const selection =
      control.input ??
      resolveDefaultModelForAgent({ cfg: control.cfg, agentId, allowPluginNormalization: false });
    const parts = await renderPreparedStatus({
      cfg: control.cfg,
      agentId,
      sessionKey: control.sessionKey ?? "agent:main:main",
      provider: selection.provider,
      model: selection.model,
      sessionEntry,
      resolvedThinkLevel: "off",
    });
    expect(parts.text).toContain(`Model: ${control.expectedModel}`);
    for (const expected of control.expected ?? []) {
      expect(parts.text).toContain(expected);
    }
    for (const absent of control.absent ?? []) {
      expect(parts.text).not.toContain(absent);
    }
    const table = parts.presentation.blocks.find((block) => block.type === "table");
    expect(table?.type === "table" ? table.rows : []).toContainEqual([
      "🧠 Model",
      expect.stringContaining(control.expectedModel),
    ]);
    expect(sessionEntry).toEqual(original);
  });

  it.each([false, true])(
    "catches only unavailable terminal projections (unavailable=%s)",
    async (unavailable) => {
      const error = unavailable
        ? new SessionTranscriptProjectionUnavailableError("projection")
        : new Error("unexpected reader failure");
      const readTail = vi
        .spyOn(transcriptTail, "readSessionTranscriptBoundedMessageTailPage")
        .mockImplementation(() => {
          throw error;
        });
      try {
        const sessionEntry: InternalSessionEntry = {
          sessionId: "projection",
          updatedAt: 1,
          status: "done",
          lastRunId: "settled-run",
          fallbackNotice: {
            kind: "active",
            selectedModel: "deepseek/deepseek-v4-flash",
            activeModel: "fallback/small-model",
          },
        };
        const result = renderPreparedStatus({ sessionEntry });
        if (unavailable) {
          expect((await result).text).not.toContain("Fallback:");
        } else {
          await expect(result).rejects.toBe(error);
        }
        expect(readTail).toHaveBeenCalledOnce();
      } finally {
        readTail.mockRestore();
      }
    },
  );

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
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
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
        fallbackNotice: {
          kind: "active",
          selectedModel: "deepseek/deepseek-v4-flash",
          activeModel: "fallback/small-model",
          reason: "provider unavailable",
        },
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
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
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
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

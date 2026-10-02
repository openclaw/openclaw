import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  buildStatusMessage as buildStatusMessageRaw,
  statusModelRefs,
} from "../status/status-message.test-support.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import * as commandsRegistry from "./commands-registry.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildToolsMessage,
} from "./status.js";

type StatusArgs = Parameters<typeof buildStatusMessageRaw>[0];

type StatusTestArgs = Omit<Partial<StatusArgs>, "sessionEntry"> & {
  sessionEntry?: Partial<NonNullable<StatusArgs["sessionEntry"]>>;
};

function buildStatusMessage({ sessionEntry, ...args }: StatusTestArgs): string {
  return buildStatusMessageRaw({
    ...statusContext,
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-opus-4-6" }),
    agent: { model: "anthropic/claude-opus-4-6" },
    ...args,
    sessionEntry: sessionEntry && { sessionId: "status", updatedAt: 0, ...sessionEntry },
  });
}

function modelArgs(provider: string, model: string): Pick<StatusArgs, "modelRefs" | "agent"> {
  return {
    modelRefs: statusModelRefs({ provider, model }),
    agent: { model: `${provider}/${model}` },
  };
}

const statusContext = {
  sessionKey: "agent:main:main",
  sessionScope: "per-sender",
  queue: { mode: "collect", depth: 0 },
} as const;

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (): Array<{ name: string; description: string; pluginId: string }> => [],
  ),
}));

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

function configureCliBackend(enabled = false): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () =>
      enabled
        ? [
            {
              id: "claude-cli",
              modelProvider: "anthropic",
              pluginId: "anthropic",
              config: { command: "claude" },
              bundleMcp: false,
            },
          ]
        : [],
  });
}

beforeEach(() => configureCliBackend());

afterEach(() => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  listPluginCommands.mockReset();
  listPluginCommands.mockImplementation(() => []);
  getContextWindowCaches().discoveredTokenCache.clear();
});

type ContextBudgetStatus = NonNullable<
  NonNullable<Parameters<typeof buildStatusMessage>[0]["sessionEntry"]>["contextBudgetStatus"]
>;

function makeContextBudgetStatus(): ContextBudgetStatus {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 1,
    provider: "anthropic",
    model: "claude-sonnet-4.6",
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 640_000,
    contextTokenBudget: 1_000_000,
    promptBudgetBeforeReserve: 900_000,
    reserveTokens: 100_000,
    effectiveReserveTokens: 100_000,
    remainingPromptBudgetTokens: 260_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
  };
}

type FallbackContextStatusOverrides = {
  activeProvider?: string;
  activeModel?: string;
  activeContextWindow?: number | null;
  runtimeContextTokens?: number;
  sessionContextTokens?: number;
};

function makeFallbackContextStatusArgs({
  activeProvider = "minimax-portal",
  activeModel = "MiniMax-M2.7",
  activeContextWindow = 200_000,
  runtimeContextTokens,
  sessionContextTokens,
}: FallbackContextStatusOverrides): Parameters<typeof buildStatusMessage>[0] {
  const providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }> = {
    xiaomi: {
      models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
    },
  };
  if (activeContextWindow !== null) {
    providers[activeProvider] = {
      models: [{ id: activeModel, contextWindow: activeContextWindow }],
    };
  }

  return {
    modelRefs: statusModelRefs(
      { provider: "xiaomi", model: "mimo-v2-flash" },
      { provider: activeProvider, model: activeModel },
    ),
    config: { models: { providers } } as unknown as OpenClawConfig,
    agent: { model: "xiaomi/mimo-v2-flash" },
    runtimeContextTokens,
    sessionEntry: {
      updatedAt: 0,
      providerOverride: "xiaomi",
      modelOverride: "mimo-v2-flash",
      modelProvider: activeProvider,
      model: activeModel,
      fallbackNotice: {
        kind: "active",
        selectedModel: "xiaomi/mimo-v2-flash",
        activeModel: `${activeProvider}/${activeModel}`,
        reason: "model not allowed",
      },
      totalTokens: 49_000,
      totalTokensFresh: true,
      totalTokensVersion: 1 as const,
      ...(sessionContextTokens === undefined
        ? {}
        : {
            contextTokens: sessionContextTokens,
            contextTokensSource: "runtime" as const,
            agentHarnessId: "openclaw" as const,
          }),
    },
    ...statusContext,
    resolvedHarness: "openclaw",
  };
}

function withStatusHome(run: () => Promise<void>) {
  return withTempHome(run, { prefix: "openclaw-status-" });
}

describe("buildStatusMessage", () => {
  it("uses estimated context budget status when fresh totalTokens are unavailable", () => {
    const text = buildStatusMessage({
      ...modelArgs("anthropic", "claude-sonnet-4.6"),
      sessionEntry: {
        inputTokens: 3_800_000,
        outputTokens: 20_000,
        totalTokens: 3_800_000,
        totalTokensFresh: false,
        contextTokens: 1_000_000,
        contextBudgetStatus: makeContextBudgetStatus(),
      },

      now: 10 * 60_000,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Context: ~640k/1.0m (64% est)");
    expect(normalized).not.toContain("Context: ?/1.0m");
    expect(normalized).not.toContain("Context: 3.8m/1.0m");
  });

  it("shows sanitized TTS provider details in the voice status line", async () => {
    await withTempHome(async () => {
      const text = buildStatusMessage({
        config: {
          tts: {
            auto: "always",
            provider: "openai",
            providers: {
              openai: {
                displayName: "NeuTTS local",
                baseUrl: "http://username@127.0.0.1:18801/v1?token=hidden#fragment",
                model: "neutts-nano",
                voice: "clara",
              },
            },
          },
        } as unknown as OpenClawConfig,
        agent: {},
        now: 0,
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain(
        "Voice: always · provider=openai · name=NeuTTS local · model=neutts-nano · voice=clara · endpoint=custom(http://127.0.0.1:18801/v1)",
      );
      expect(normalized).not.toContain("username");
      expect(normalized).not.toContain("token=hidden");
      expect(normalized).not.toContain("fragment");
    });
  });

  it("sanitizes runtime labels sourced from session metadata", () => {
    const text = buildStatusMessage({
      sessionEntry: {
        acp: {
          backend: "acpx\nrewritten",
          agent: "gemini\u001b[2K",
          runtimeSessionName: "status-test",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 0,
        },
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Runtime: gemini (acp/acpx\\nrewritten)");
    expect(text).not.toContain("\u001b");
  });

  it("shows plugin status lines only when verbose is enabled", () => {
    const render = (verboseLevel: "on" | "off") =>
      normalizeTestText(
        buildStatusMessage({
          ...modelArgs("anthropic", "test:opus"),
          sessionEntry: {
            verboseLevel,
            pluginDebugEntries: [
              {
                pluginId: "active-memory",
                lines: ["🧩 Active Memory: status=timeout elapsed=15s query=recent"],
              },
            ],
          },
        }),
      );
    expect(render("on")).toContain("Active Memory: status=timeout elapsed=15s query=recent");
    expect(render("off")).not.toContain("Active Memory: status=timeout elapsed=15s query=recent");
  });

  it("shows trace lines only when trace is enabled", () => {
    const render = (sessionEntry: NonNullable<StatusTestArgs["sessionEntry"]>) =>
      normalizeTestText(
        buildStatusMessage({
          ...modelArgs("anthropic", "test:opus"),
          sessionEntry: {
            ...sessionEntry,
            pluginDebugEntries: [
              {
                pluginId: "active-memory",
                lines: ["🔎 Active Memory Debug: spicy ramen; tacos"],
              },
            ],
          },
        }),
      );
    expect(render({ verboseLevel: "on" })).not.toContain("Active Memory Debug: spicy ramen; tacos");
    const visible = render({ verboseLevel: "off", traceLevel: "on" });
    expect(visible).toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("trace");
  });

  it("uses the channel override model context window instead of stale persisted context", () => {
    const text = buildStatusMessage({
      ...modelArgs("minimax-portal", "MiniMax-M2.7"),
      config: {
        channels: {
          modelByChannel: {
            discord: {
              "123": "minimax-portal/MiniMax-M2.7",
            },
          },
        },
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            anthropic: {
              models: [{ id: "claude-opus-4-6", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        groupId: "123",
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_048_576,
      },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("channel override");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it.each([
    {
      name: "recomputes context window from the active fallback model when session contextTokens are stale",
      overrides: {
        sessionContextTokens: 1_048_576,
      },
      expectedFallback: "Fallback: minimax-portal/MiniMax-M2.7",
      expectedContext: "Context: 49k/200k",
      unexpectedContext: "Context: 49k/1.0m",
    },
    {
      name: "keeps a persisted fallback limit when the active runtime model lookup is unavailable",
      overrides: {
        activeProvider: "custom-runtime",
        activeModel: "unknown-fallback-model",
        activeContextWindow: null,
        sessionContextTokens: 128_000,
      },
      expectedFallback: "Fallback: custom-runtime/unknown-fallback-model",
      expectedContext: "Context: 49k/128k",
      unexpectedContext: "Context: 49k/1.0m",
    },
  ])("$name", ({ overrides, expectedFallback, expectedContext, unexpectedContext }) => {
    const normalized = normalizeTestText(
      buildStatusMessage(makeFallbackContextStatusArgs(overrides)),
    );

    expect(normalized).toContain(expectedFallback);
    expect(normalized).toContain(expectedContext);
    expect(normalized).not.toContain(unexpectedContext);
  });

  function buildCliAliasStatus({ sessionEntry, ...args }: StatusTestArgs) {
    configureCliBackend(true);
    return buildStatusMessage({
      modelRefs: statusModelRefs(
        { provider: "anthropic", model: "claude-opus-4-7" },
        { provider: "claude-cli", model: "claude-opus-4-7" },
      ),
      agent: {
        model: "anthropic/claude-opus-4-7",
      },
      activeModelAuth: "oauth (anthropic:claude-cli)",
      ...args,
      sessionEntry: {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelProvider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackNotice: {
          kind: "active",
          selectedModel: "anthropic/claude-opus-4-7",
          activeModel: "claude-cli/claude-opus-4-7",
          reason: "selected model unavailable",
        },
        inputTokens: 29,
        outputTokens: 19_000,
        ...sessionEntry,
      },
    });
  }

  it("renders CLI runtime aliases as the selected model route", () => {
    const text = buildCliAliasStatus({
      sessionEntry: {
        cacheRead: 3_000_000,
        totalTokens: 36_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_000_000,
      },
      modelAuth: "unknown",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
    expect(normalized).toContain("oauth (anthropic:claude-cli)");
    expect(normalized).not.toContain("Fallback: claude-cli/claude-opus-4-7");
    expect(normalized).not.toContain("Auth: unknown");
    expect(normalized).toContain("Endpoint: unknown");
    expect(normalized).toContain("Context: 36k/200k (18%)");
  });

  it("prefers active CLI OAuth over selected env API-key labels for runtime aliases", () => {
    const text = buildCliAliasStatus({
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-opus-4-7",
                  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {},
      modelAuth: "api-key (env: ANTHROPIC_API_KEY)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
    expect(normalized).toContain("oauth (anthropic:claude-cli)");
    expect(normalized).not.toContain("api-key (env: ANTHROPIC_API_KEY)");
    expect(normalized).not.toContain("Fallback: claude-cli/claude-opus-4-7");
    expect(normalized).not.toContain("Cost:");
  });

  it.each([
    {
      name: "keeps an explicit runtime context limit when fallback status already computed one",
      overrides: {
        runtimeContextTokens: 123_456,
        sessionContextTokens: 1_048_576,
      },
    },
    {
      name: "keeps the persisted runtime context limit for fallback sessions when no live override is passed",
      overrides: {
        sessionContextTokens: 123_456,
      },
    },
  ])("$name", ({ overrides }) => {
    const normalized = normalizeTestText(
      buildStatusMessage(makeFallbackContextStatusArgs(overrides)),
    );

    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("uses per-agent sandbox config when config and session key are provided", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "discord", sandbox: { mode: "all" } },
          ],
        },
      } as unknown as OpenClawConfig,
      agent: {},
      sessionKey: "agent:discord:discord:channel:1456350065223270435",
    });

    expect(normalizeTestText(text)).toContain("Execution: docker/all");
  });

  it("includes media understanding decisions when present", () => {
    const text = buildStatusMessage({
      queue: { mode: "none" },
      mediaDecisions: [
        createSuccessfulImageMediaDecision() as unknown as NonNullable<
          Parameters<typeof buildStatusMessage>[0]["mediaDecisions"]
        >[number],
        {
          capability: "audio",
          outcome: "skipped",
          attachmentDispositions: { 1: { kind: "failed" } },
          attachments: [
            {
              attachmentIndex: 1,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
        },
      ],
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Media: image ok (openai/gpt-5.4) · audio skipped (maxBytes)");
  });

  it("distinguishes observed local STT backends from requested backends", () => {
    const text = buildStatusMessage({
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "audio",
          outcome: "success",
          attachmentDispositions: { 0: { kind: "handled" } },
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [],
              chosen: {
                type: "cli",
                provider: "whisper-cli",
                model: "whisper-cli",
                requestedBackend: "device:0",
                observedBackend: "metal",
                outcome: "success",
              },
            },
          ],
        },
      ],
    });

    expect(normalizeTestText(text)).toContain("Media: audio ok (whisper-cli observed=metal)");
  });

  it("includes failed media understanding decisions with the surfaced reason", () => {
    const text = buildStatusMessage({
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "audio",
          outcome: "failed",
          attachmentDispositions: { 0: { kind: "failed" } },
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "empty output",
                },
                {
                  type: "provider",
                  outcome: "failed",
                  reason: "Error: Audio transcription response missing text",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(normalizeTestText(text)).toContain(
      "Media: audio failed (Audio transcription response missing text)",
    );
    expect(normalizeTestText(text)).not.toContain("empty output");
  });

  it("shows the selected model and authenticated fallback route", () => {
    const text = buildStatusMessage({
      modelRefs: statusModelRefs(
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
      ),

      sessionEntry: {
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai/gpt-4.1-mini",
          activeModel: "anthropic/claude-haiku-4-5",
          reason: "rate limit",
        },
        contextTokens: 32_000,
      },
      modelAuth: "api-key",
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).toContain("Fallback: anthropic/claude-haiku-4-5");
    expect(normalized).toContain("(rate limit)");
    expect(normalized).not.toContain(" - Reason:");
    expect(normalized).not.toContain("Active:");
    expect(normalized).toContain("di_123...abc");
  });

  it("omits active fallback details when runtime drift does not match fallback state", () => {
    const text = buildStatusMessage({
      modelRefs: statusModelRefs(
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
      ),
      agent: {
        model: "openai/gpt-4.1-mini",
      },
      sessionEntry: {
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
          activeModel: "deepinfra/moonshotai/Kimi-K2.5",
          reason: "rate limit",
        },
      },

      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).not.toContain("Fallback:");
    expect(normalized).not.toContain("(rate limit)");
  });

  it("shows configured fallback models when provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5-mini"],
        },
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallbacks: google/gemini-2.5-flash, openai/gpt-5-mini");
  });

  it("omits configured fallbacks for a session-selected model", () => {
    const text = buildStatusMessage({
      modelRefs: statusModelRefs({ provider: "google", model: "gemini-3.1-flash-lite" }),
      configuredDefaultModelLabel: "google/gemini-3-flash-preview",
      agent: {
        model: {
          primary: "google/gemini-3-flash-preview",
          fallbacks: [
            "google/gemini-3.1-flash-lite",
            "google/gemini-2.5-flash",
            "google/gemini-3.1-pro-preview",
          ],
        },
      },
      sessionEntry: {
        modelProvider: "google",
        model: "gemini-3.1-flash-lite",
        modelOverride: "gemini-3.1-flash-lite",
        modelOverrideSource: "user",
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: google/gemini-3.1-flash-lite");
    expect(normalized).not.toContain("Fallbacks:");
  });

  it("shows queue details when overridden", () => {
    const text = buildStatusMessage({
      agent: {},
      queue: {
        mode: "collect",
        depth: 3,
        debounceMs: 2000,
        cap: 5,
        dropPolicy: "old",
        showDetails: true,
      },
    });

    expect(text).toContain("Queue: collect (depth 3 · debounce 2s · cap 5 · drop old)");
  });

  function writeTranscriptUsageLog(params: {
    agentId: string;
    sessionId: string;
    model?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }) {
    const scope = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: `agent:${params.agentId}:main`,
      storePath: resolveSessionStorePathCore(undefined, { agentId: params.agentId }),
    };
    replaceSessionEntrySync(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      message: {
        role: "assistant",
        model: params.model ?? "claude-opus-4-6",
        usage: params.usage ?? baselineTranscriptUsage,
      },
    });
  }

  const baselineTranscriptUsage = {
    input: 1,
    output: 2,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: 1003,
  } as const;

  function buildTranscriptStatusText(params: { sessionId: string; sessionKey: string }) {
    return buildStatusMessage({
      sessionEntry: {
        sessionId: params.sessionId,
        totalTokens: 3,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        agentHarnessId: "openclaw",
        contextTokens: 32_000,
        contextTokensSource: "runtime",
      },
      sessionKey: params.sessionKey,
      includeTranscriptUsage: true,
      resolvedHarness: "openclaw",
    });
  }

  it("reads transcript usage for non-default agents", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-worker1";
      writeTranscriptUsageLog({ agentId: "worker1", sessionId });
      const text = buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:worker1:telegram:12345",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });

  it("does not render stale context usage from transcript fallback", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-stale-transcript-context";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        usage: {
          input: 3_800_000,
          output: 20_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3_820_000,
        },
      });

      const text = buildStatusMessage({
        sessionEntry: {
          sessionId,

          inputTokens: 3_800_000,
          outputTokens: 20_000,
          totalTokens: 3_800_000,
          totalTokensFresh: false,
          contextTokens: 1_000_000,
        },
        includeTranscriptUsage: true,
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain("Context: ?/1.0m");
      expect(normalized).not.toContain("Context: 3.8m/1.0m");
      expect(normalized).not.toContain("Context: 3.82m/1.0m");
    });
  });

  it("does not let legacy cumulative session totals override fresh transcript context usage", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-legacy-cumulative-context";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        usage: {
          input: 10_000,
          output: 1_000,
          cacheRead: 26_000,
          cacheWrite: 0,
          totalTokens: 36_000,
        },
      });

      const text = buildStatusMessage({
        sessionEntry: {
          sessionId,

          inputTokens: 16,
          outputTokens: 5_100,
          cacheRead: 2_300_000,
          cacheWrite: 11_000,
          totalTokens: 2_300_000,
          contextTokens: 1_000_000,
        },
        includeTranscriptUsage: true,
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain("Cache: 100% hit · 2.3m cached, 11k new");
      expect(normalized).toContain("Context: 36k/1.0m (4%)");
      expect(normalized).not.toContain("Context: 2.3m/1.0m");
    });
  });

  it("reads transcript usage using explicit agentId when sessionKey is missing", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-worker2";
      writeTranscriptUsageLog({
        agentId: "worker2",
        sessionId,
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = buildStatusMessage({
        agentId: "worker2",
        sessionEntry: {
          sessionId,
          totalTokens: 5,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          agentHarnessId: "openclaw",
          contextTokens: 32_000,
          contextTokensSource: "runtime",
        },
        sessionKey: undefined,
        includeTranscriptUsage: true,
        resolvedHarness: "openclaw",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.2k/32k");
    });
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-cache-delivery-mirror";
      writeTranscriptUsageLog({ agentId: "main", sessionId });
      appendTranscriptMessageSync(
        {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        {
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
            },
          },
        },
      );

      const text = buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:main:main",
      });

      expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });

  it("keeps transcript-derived slash model ids on model-only context lookup", async () => {
    await withStatusHome(async () => {
      getContextWindowCaches().discoveredTokenCache.set("google/gemini-2.5-pro", 999_000);

      const sessionId = "sess-openrouter-google";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        model: "google/gemini-2.5-pro",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = buildStatusMessage({
        ...modelArgs("openrouter", "google/gemini-2.5-pro"),
        config: {
          models: {
            providers: {
              google: {
                models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        sessionEntry: {
          sessionId,
          totalTokens: 5,
        },
        includeTranscriptUsage: true,
      });

      const normalized = normalizeTestText(text);
      expect(normalized).toContain("Context: 1.2k/999k");
      expect(normalized).not.toContain("Context: 1.2k/2.0m");
    });
  });

  it("keeps runtime slash model ids on model-only context lookup when modelProvider is missing", () => {
    getContextWindowCaches().discoveredTokenCache.set("google/gemini-2.5-pro", 999_000);

    const text = buildStatusMessage({
      ...modelArgs("openrouter", "google/gemini-2.5-pro"),
      config: {
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        totalTokens: 1205,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "google/gemini-2.5-pro",
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    getContextWindowCaches().discoveredTokenCache.clear();

    const text = buildStatusMessage({
      modelRefs: statusModelRefs(
        { provider: "xiaomi", model: "mimo-v2-flash" },
        { provider: "fake-minimax", model: "FakeMiniMax-M2.5" },
      ),
      config: {
        models: {
          providers: {
            "fake-minimax": {
              models: [{ id: "FakeMiniMax-M2.5", contextWindow: 777_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        model: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "xiaomi/mimo-v2-flash",
          activeModel: "fake-minimax/FakeMiniMax-M2.5",
          reason: "model not allowed",
        },
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    getContextWindowCaches().discoveredTokenCache.clear();

    const text = buildStatusMessage({
      ...modelArgs("openai", "gpt-4o"),
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-4o", contextWindow: 777_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        model: "openai/gpt-4o",
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for bare transcript model ids", async () => {
    await withStatusHome(async () => {
      getContextWindowCaches().discoveredTokenCache.set("gemini-2.5-pro", 128_000);
      getContextWindowCaches().discoveredTokenCache.set(
        providerContextTokenCacheKey("google-gemini-cli", "gemini-2.5-pro"),
        1_000_000,
      );

      const sessionId = "sess-google-bare-model";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        model: "gemini-2.5-pro",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = buildStatusMessage({
        ...modelArgs("google-gemini-cli", "gemini-2.5-pro"),
        sessionEntry: {
          sessionId,
          totalTokens: 5,
        },
        includeTranscriptUsage: true,
      });

      const normalized = normalizeTestText(text);
      expect(normalized).toContain("Context: 1.2k/1.0m");
      expect(normalized).not.toContain("Context: 1.2k/128k");
    });
  });
});

describe("buildCommandsMessage", () => {
  it("lists commands with aliases and hints", () => {
    const text = buildCommandsMessage(
      {
        commands: { config: false, debug: false },
      },
      [{ name: "demo_skill", skillName: "demo-skill", description: "Demo skill" }],
    );
    expect(text).toContain("ℹ️ Slash commands");
    expect(text).toContain("Status");
    expect(text).toContain("/demo_skill - Demo skill");
    expect(text).toContain("/commands - List all slash commands.");
    expect(text).toContain("/skill - Run a skill by name.");
    expect(text).toContain("/think (/thinking, /t) - Set thinking level.");
    expect(text).toContain("/compact - Compact the session context.");
    expect(text).toContain("/models - List model providers/models.");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });
});

describe("buildHelpMessage", () => {
  it("hides config/debug when disabled", () => {
    const text = buildHelpMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("Skills");
    expect(text).toContain("/skill <name> [input]");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes /fast in help output", () => {
    expect(buildHelpMessage()).toContain("/fast status|auto|on|off|ultrafast|default");
  });
});

describe("buildCommandsMessagePaginated", () => {
  it("includes plugin commands in the paginated list", () => {
    const pluginCommands = [
      { name: "plugin_cmd", description: "Plugin command", pluginId: "demo-plugin" },
    ];
    listPluginCommands.mockImplementation(() => pluginCommands);
    const firstPage = buildCommandsMessagePaginated(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    expect(firstPage.text).toContain("ℹ️ Commands (1/");
    expect(firstPage.text).toContain("Session");
    expect(firstPage.text).toContain("/stop - Stop the current run.");
    const pages = Array.from({ length: firstPage.totalPages }, (_, index) =>
      buildCommandsMessagePaginated(
        {
          commands: { config: false, debug: false },
        } as unknown as OpenClawConfig,
        undefined,
        { surface: "telegram", page: index + 1, forcePaginatedList: true },
      ),
    );
    const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
    if (!pluginPage) {
      throw new Error("expected plugin command page");
    }
    expect(pluginPage.text).toContain("Plugins");
    expect(pluginPage.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("buildToolsMessage", () => {
  const tool = (id: string, label: string, description: string, pluginId?: string) => ({
    id,
    label,
    description,
    rawDescription: description,
    source: pluginId ? ("plugin" as const) : ("core" as const),
    pluginId,
  });

  it("groups shipped docks commands with tools", () => {
    vi.spyOn(commandsRegistry, "listChatCommands").mockReturnValue([
      {
        key: "saved-layout",
        description: "Inspect a saved layout.",
        textAliases: ["/saved-layout"],
        scope: "text",
        category: "docks",
      },
      {
        key: "inspect-tool",
        description: "Inspect a tool.",
        textAliases: ["/inspect-tool"],
        scope: "text",
        category: "tools",
      },
    ]);
    const text = buildCommandsMessage();
    expect(text).toContain("Tools\n  /saved-layout [text] - Inspect a saved layout.");
    expect(text).toContain("  /inspect-tool [text] - Inspect a tool.");
    expect(text.match(/^Tools$/gm)).toHaveLength(1);
    expect(text).not.toContain("Docks");
  });

  it("renders compact inventory with plugin ownership and availability notices", () => {
    const text = buildToolsMessage({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            tool("exec", "Exec", "Run shell commands"),
            tool("web_search", "Web Search", "Search the web"),
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [tool("docs_lookup", "Docs Lookup", "Search internal documentation", "docs")],
        },
      ],
      notices: [
        {
          id: "browser-filtered-by-profile",
          severity: "info",
          message:
            'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"].',
        },
      ],
    });
    expect(text).toContain("Available tools");
    expect(text).toContain("Profile: coding");
    expect(text).toContain("Built-in tools");
    expect(text).toContain("exec, web_search");
    expect(text).toContain("Connected tools");
    expect(text).toContain("docs_lookup (docs)");
    expect(text).toContain("Use /tools verbose for descriptions.");
    expect(text).not.toContain("unavailable right now");
    expect(text).toContain("Notes");
    expect(text).toContain('Add tools.alsoAllow: ["browser"].');
  });

  it("trims verbose descriptions before schema-like doc blocks", () => {
    const text = buildToolsMessage(
      {
        agentId: "main",
        profile: "coding",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [
              {
                ...tool("cron", "Cron", "Schedule and manage cron jobs."),
                rawDescription:
                  'Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
              },
            ],
          },
        ],
      },
      { verbose: true },
    );
    expect(text).toContain(
      'Cron - Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.',
    );
    expect(text).toContain("What this agent can use right now:");
    expect(text).toContain("Tool availability depends on this agent's configuration.");
    expect(text).not.toContain("ACTIONS:");
    expect(text).not.toContain("JOB SCHEMA:");
  });

  it("returns the empty state when no tools are available", () => {
    expect(buildToolsMessage({ agentId: "main", profile: "full", groups: [] })).toBe(
      "No tools are available for this agent right now.\n\nProfile: full",
    );
  });
});

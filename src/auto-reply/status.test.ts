import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingDecision } from "../../packages/media-understanding-common/src/types.js";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { readRecentSessionUsageFromTranscriptAsync } from "../gateway/session-transcript-usage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import * as commandsRegistry from "./commands-registry.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildToolsMessage,
} from "./status.js";
import {
  buildStatusMessage,
  configureCliBackend,
  fallbackRoute,
  normalizedStatus,
  modelArgs,
  providerModels,
  statusContext,
  type StatusTestArgs,
} from "./status.test-fixtures.js";

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (): Array<{ name: string; description: string; pluginId: string }> => [],
  ),
}));

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

const commandConfig = { commands: { config: false, debug: false } };
beforeEach(() => configureCliBackend());
afterEach(() => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  listPluginCommands.mockReset().mockImplementation(() => []);
});

function audioDecision(
  outcome: MediaUnderstandingDecision["outcome"],
  attempts: MediaUnderstandingDecision["attachments"][number]["attempts"],
  chosen?: MediaUnderstandingDecision["attachments"][number]["chosen"],
  attachmentIndex = 0,
): MediaUnderstandingDecision {
  return {
    capability: "audio",
    outcome,
    attachmentDispositions: {
      [attachmentIndex]: { kind: outcome === "success" ? "handled" : "failed" },
    },
    attachments: [{ attachmentIndex, attempts, ...(chosen ? { chosen } : {}) }],
  };
}

const selected = { provider: "source", model: "large" };
const active = { provider: "target", model: "small" };
function fallbackContext(window: number | null, session: number, runtime?: number): StatusTestArgs {
  const route = fallbackRoute(selected, active);
  const providers: Parameters<typeof providerModels> = [
    ["source", "large", { contextWindow: 1_048_576 }],
  ];
  if (window !== null) {
    providers.push(["target", "small", { contextWindow: window }]);
  }
  return {
    ...route,
    config: providerModels(...providers),
    runtimeContextTokens: runtime,
    resolvedHarness: "openclaw",
    sessionEntry: {
      ...route.sessionEntry,
      ...freshUsage(49_000),
      contextTokens: session,
      contextTokensSource: "runtime",
      agentHarnessId: "openclaw",
    },
  };
}

it("shows sanitized TTS provider details in the voice status line", async () => {
  await withTempHome(async () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(0);
    const normalized = normalizedStatus({
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
    });

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

  expect(normalizeTestText(text)).toContain("Runtime: gemini (acp/acpx\\nrewritten)");
  expect(text).not.toContain("\u001b");
});

it("shows trace lines only when trace is enabled", () => {
  const render = (sessionEntry: NonNullable<StatusTestArgs["sessionEntry"]>) =>
    normalizedStatus({
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
    });
  expect(render({ verboseLevel: "on" })).not.toContain("Active Memory Debug: spicy ramen; tacos");
  const visible = render({ verboseLevel: "off", traceLevel: "on" });
  expect(visible).toContain("Active Memory Debug: spicy ramen; tacos");
  expect(visible).toContain("trace");
});

it.each([undefined, "MiniMax-M2.7"])(
  "uses the channel override model context window with explicit override=%s",
  (modelOverride) => {
    const normalized = normalizedStatus({
      ...modelArgs("minimax-portal", "MiniMax-M2.7"),
      config: {
        ...providerModels(
          ["minimax-portal", "MiniMax-M2.7", { contextWindow: 200_000 }],
          ["anthropic", "claude-opus-4-6", { contextWindow: 1_048_576 }],
        ),
        channels: {
          modelByChannel: {
            discord: {
              "123": "minimax-portal/MiniMax-M2.7",
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        groupId: "123",
        ...freshUsage(49_000),
        contextTokens: 1_048_576,
        modelOverride,
      },
    });

    expect(normalized).toContain("Model: minimax-portal/MiniMax-M2.7");
    expect(normalized.includes("channel override")).toBe(modelOverride === undefined);
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  },
);

it.each<[number | null, number, number | undefined, string]>([
  [200_000, 1_048_576, undefined, "49k/200k"],
  [null, 128_000, undefined, "49k/128k"],
  [200_000, 1_048_576, 123_456, "49k/123k"],
  [200_000, 123_456, undefined, "49k/123k"],
])("renders fallback limits %j/%j/%j as %s", (window, session, runtime, context) => {
  const text = normalizedStatus(fallbackContext(window, session, runtime));
  expect(text).toContain("Fallback: target/small");
  expect(text).toContain(`Context: ${context}`);
  expect(text).not.toContain("Context: 49k/1.0m");
  expect(text.includes("Context: 49k/200k")).toBe(context === "49k/200k");
});

function buildCliAliasStatus({ sessionEntry, ...args }: StatusTestArgs) {
  configureCliBackend(true);
  const route = fallbackRoute(
    { provider: "anthropic", model: "claude-opus-4-7" },
    { provider: "claude-cli", model: "claude-opus-4-7" },
    "selected model unavailable",
  );
  return buildStatusMessage({
    ...route,
    activeModelAuth: "oauth (anthropic:claude-cli)",
    ...args,
    sessionEntry: {
      ...route.sessionEntry,
      inputTokens: 29,
      outputTokens: 19_000,
      ...sessionEntry,
    },
  });
}

it.each<[StatusTestArgs, string[], string[]]>([
  [
    {
      sessionEntry: {
        cacheRead: 3_000_000,
        ...freshUsage(36_000),
        contextTokens: 1_000_000,
      },
      modelAuth: "unknown",
    },
    ["Endpoint: unknown", "Context: 36k/?"],
    ["Auth: unknown"],
  ],
  [
    {
      config: providerModels([
        "anthropic",
        "claude-opus-4-7",
        {
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
      ]),
      sessionEntry: {},
      modelAuth: "api-key (env: ANTHROPIC_API_KEY)",
    },
    [],
    ["api-key (env: ANTHROPIC_API_KEY)", "Cost:"],
  ],
])("renders CLI alias with %j", (args, present, absent) => {
  const text = normalizeTestText(buildCliAliasStatus(args));
  expect(text).toContain("Model: anthropic/claude-opus-4-7");
  expect(text).toContain("oauth (anthropic:claude-cli)");
  present.forEach((snippet) => expect(text).toContain(snippet));
  expect(text).not.toContain("Fallback: claude-cli/claude-opus-4-7");
  absent.forEach((snippet) => expect(text).not.toContain(snippet));
});

it.each<[MediaUnderstandingDecision[], string, string?]>([
  [
    [
      createSuccessfulImageMediaDecision(),
      audioDecision(
        "skipped",
        [{ type: "provider", outcome: "skipped", reason: "maxBytes: too large" }],
        undefined,
        1,
      ),
    ],
    "Media: image ok (openai/gpt-5.4) · audio skipped (maxBytes)",
  ],
  [
    [
      audioDecision("success", [], {
        type: "cli",
        provider: "whisper-cli",
        model: "whisper-cli",
        requestedBackend: "device:0",
        observedBackend: "metal",
        outcome: "success",
      }),
    ],
    "Media: audio ok (whisper-cli observed=metal)",
  ],
  [
    [
      audioDecision("failed", [
        { type: "provider", outcome: "skipped", reason: "empty output" },
        {
          type: "provider",
          outcome: "failed",
          reason: "Error: Audio transcription response missing text",
        },
      ]),
    ],
    "Media: audio failed (Audio transcription response missing text)",
    "empty output",
  ],
])("renders media decisions %j", (mediaDecisions, expected, absent) => {
  const text = normalizeTestText(buildStatusMessage({ queue: { mode: "none" }, mediaDecisions }));
  expect(text).toContain(expected);
  if (absent) {
    expect(text).not.toContain(absent);
  }
});

it.each([false, true])("renders configured fallbacks with a pinned model=%s", (pinned) => {
  const text = normalizedStatus({
    ...modelArgs("google", pinned ? "small" : "primary"),
    configuredDefaultModelLabel: "google/primary",
    agent: { model: { primary: "google/primary", fallbacks: ["google/small", "openai/other"] } },
    sessionEntry: pinned
      ? {
          modelProvider: "google",
          model: "small",
          modelOverride: "small",
          modelOverrideSource: "user",
        }
      : undefined,
  });
  expect(text).toContain(pinned ? "Model: google/small" : "Fallbacks: google/small, openai/other");
  expect(text.includes("Fallbacks:")).toBe(!pinned);
});

it("lists commands with aliases and hints", () => {
  const text = buildCommandsMessage(commandConfig, [
    { name: "demo_skill", skillName: "demo-skill", description: "Demo skill" },
  ]);
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

it("includes plugin commands in the paginated list", () => {
  listPluginCommands.mockReturnValue([
    { name: "plugin_cmd", description: "Plugin command", pluginId: "demo-plugin" },
  ]);
  const renderPage = (page = 1) =>
    buildCommandsMessagePaginated(commandConfig, undefined, {
      surface: "telegram",
      page,
      forcePaginatedList: true,
    });
  const firstPage = renderPage();
  expect(firstPage.text).toContain("ℹ️ Commands (1/");
  expect(firstPage.text).toContain("Session");
  expect(firstPage.text).toContain("/stop - Stop the current run.");
  const pages = Array.from({ length: firstPage.totalPages }, (_, index) => renderPage(index + 1));
  const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
  expect(pluginPage?.text).toContain("Plugins");
  expect(pluginPage?.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
});

const tool = (id: string, label: string, description: string, pluginId?: string) => ({
  id,
  label,
  description,
  rawDescription: description,
  source: pluginId ? ("plugin" as const) : ("core" as const),
  pluginId,
});

function group(tools: ReturnType<typeof tool>[], source: "core" | "plugin" = "core") {
  return {
    id: source,
    label: source === "core" ? "Built-in tools" : "Connected tools",
    source,
    tools,
  };
}

it("groups shipped docks commands with tools", () => {
  vi.spyOn(commandsRegistry, "listChatCommands").mockReturnValue(
    (["docks", "tools"] as const).map((category) => ({
      key: category,
      description: category,
      textAliases: [`/${category}`],
      scope: "text",
      category,
    })),
  );
  const text = buildCommandsMessage();
  expect(text).toContain("Tools\n  /docks [text] - docks");
  expect(text).toContain("  /tools [text] - tools");
  expect(text.match(/^Tools$/gm)).toHaveLength(1);
  expect(text).not.toContain("Docks");
});

it("renders compact inventory with plugin ownership and availability notices", () => {
  const text = buildToolsMessage({
    agentId: "main",
    profile: "coding",
    groups: [
      group([
        tool("exec", "Exec", "Run shell commands"),
        tool("web_search", "Web Search", "Search the web"),
      ]),
      group([tool("docs_lookup", "Docs", "Search docs", "docs")], "plugin"),
    ],
    notices: [
      {
        id: "browser-filtered-by-profile",
        severity: "info",
        message: 'Add tools.alsoAllow: ["browser"].',
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
        group([
          {
            ...tool("cron", "Cron", "Schedule jobs."),
            rawDescription:
              "Schedule jobs.\n\nACTIONS:\n- status: Check status\nJOB SCHEMA:\n{ ... }",
          },
        ]),
      ],
    },
    { verbose: true },
  );
  expect(text).toContain("Cron - Schedule jobs.");
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

const openrouterArgs = {
  ...modelArgs("openrouter", "google/gemini-2.5-pro"),
  thinkingCatalog: [
    { provider: "openrouter", id: "google/gemini-2.5-pro", contextWindow: 999_000 },
    { provider: "google", id: "gemini-2.5-pro", contextWindow: 2_000_000 },
  ],
  config: providerModels(["google", "gemini-2.5-pro", { contextWindow: 2_000_000 }]),
};
function usage(input: number, output: number, cacheRead: number, totalTokens: number) {
  return { input, output, cacheRead, cacheWrite: 0, totalTokens };
}
function freshUsage(totalTokens: number) {
  return { totalTokens, totalTokensFresh: true, totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION };
}
function withStatusHome(run: () => Promise<void>) {
  return withTempHome(
    async () => {
      setRuntimeConfigSnapshot({});
      await run();
    },
    { prefix: "openclaw-status-" },
  ).finally(clearRuntimeConfigSnapshot);
}

describe("status transcript usage and model context", () => {
  function transcriptFixture(
    params: {
      agentId?: string;
      model?: string;
      usage?: ReturnType<typeof usage>;
    } = {},
  ) {
    const agentId = params.agentId ?? "main";
    const scope = {
      agentId,
      sessionId: "status-transcript",
      sessionKey: `agent:${agentId}:main`,
      storePath: resolveSessionStorePathCore(undefined, { agentId }),
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    const append = (message: Parameters<typeof appendTranscriptMessageSync>[1]["message"]) =>
      appendTranscriptMessageSync(scope, { message });
    append({
      role: "assistant",
      model: params.model ?? "claude-opus-4-6",
      usage: params.usage ?? usage(1, 2, 1000, 1003),
    });
    return {
      append,
      render: async (args: StatusTestArgs = {}) => {
        const sessionKey = "sessionKey" in args ? args.sessionKey : statusContext.sessionKey;
        const readerAgentId =
          args.agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
        const transcriptUsage = await readRecentSessionUsageFromTranscriptAsync(
          {
            agentId: readerAgentId,
            sessionId: scope.sessionId,
            sessionKey,
            storePath: resolveSessionStorePathCore(undefined, { agentId: readerAgentId }),
          },
          256 * 1024,
        );
        return buildStatusMessage({
          ...args,
          sessionEntry: { sessionId: scope.sessionId, ...args.sessionEntry },
          transcriptUsage,
        });
      },
    };
  }

  const runtimeEntry = {
    totalTokens: 3,
    modelProvider: "anthropic",
    model: "claude-opus-4-6",
    agentHarnessId: "openclaw" as const,
    contextTokens: 32_000,
    contextTokensSource: "runtime" as const,
  };

  it("reads fresh non-default agent usage while ignoring delivery mirrors", async () => {
    await withStatusHome(async () => {
      const { render, append } = transcriptFixture({ agentId: "worker1" });
      const args: StatusTestArgs = {
        sessionEntry: runtimeEntry,
        sessionKey: "agent:worker1:telegram:12345",
        resolvedHarness: "openclaw",
      };
      expect(normalizeTestText(await render(args))).toContain("Context: 1.0k/32k");
      append({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: usage(0, 0, 0, 0),
      });
      const mirrored = normalizeTestText(await render(args));
      expect(mirrored).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      expect(mirrored).toContain("Context: 1.0k/32k");
      append({ role: "assistant", usage: { input: 2_000, output: 20, totalTokens: 2_000 } });
      expect(normalizeTestText(await render(args))).toContain("Context: 2.0k/32k");
    });
  });

  it.each([
    {
      name: "does not render stale context usage from transcript fallback",
      transcript: usage(3_800_000, 20_000, 0, 3_820_000),
      entry: {
        inputTokens: 3_800_000,
        outputTokens: 20_000,
        totalTokens: 3_800_000,
        totalTokensFresh: false,
      },
      present: ["Context: ?/1.0m"],
      absent: ["Context: 3.8m/1.0m", "Context: 3.82m/1.0m"],
    },
    {
      name: "does not let legacy cumulative session totals override fresh transcript context usage",
      transcript: usage(10_000, 1_000, 26_000, 36_000),
      entry: {
        inputTokens: 16,
        outputTokens: 5_100,
        cacheRead: 2_300_000,
        cacheWrite: 11_000,
        totalTokens: 2_300_000,
      },
      present: ["Cache: 100% hit · 2.3m cached, 11k new", "Context: 37k/1.0m (4%)"],
      absent: ["Context: 2.3m/1.0m"],
    },
  ])("$name", async ({ transcript, entry, present, absent }) => {
    await withStatusHome(async () => {
      const { render } = transcriptFixture({ usage: transcript });
      const text = normalizeTestText(
        await render({
          sessionEntry: { contextTokens: 1_000_000, ...entry },
        }),
      );
      present.forEach((snippet) => expect(text).toContain(snippet));
      absent.forEach((snippet) => expect(text).not.toContain(snippet));
    });
  });

  it.each([
    ["slash", "google/gemini-2.5-pro", openrouterArgs, "999k", "2.0m"],
    [
      "bare",
      "gemini-2.5-pro",
      {
        ...modelArgs("google-gemini-cli", "gemini-2.5-pro"),
        thinkingCatalog: [
          { provider: "google-gemini-cli", id: "gemini-2.5-pro", contextWindow: 1_000_000 },
          { provider: "google", id: "gemini-2.5-pro", contextWindow: 128_000 },
        ],
      },
      "1.0m",
      "128k",
    ],
  ] as const)(
    "keeps transcript-derived %s model ids in their admitted provider catalog",
    async (_kind, model, args, context, otherContext) => {
      await withStatusHome(async () => {
        const { render } = transcriptFixture({
          model,
          usage: usage(2, 3, 1200, 1205),
        });
        const normalized = normalizeTestText(
          await render({
            ...args,
            thinkingCatalog: [...args.thinkingCatalog],
            sessionEntry: { totalTokens: 5 },
          }),
        );
        expect(normalized).toContain(`Context: 1.2k/${context}`);
        expect(normalized).not.toContain(`Context: 1.2k/${otherContext}`);
      });
    },
  );

  it("keeps runtime slash model ids in their admitted provider catalog when modelProvider is missing", () => {
    const text = buildStatusMessage({
      ...openrouterArgs,
      sessionEntry: {
        ...freshUsage(1205),
        model: "google/gemini-2.5-pro",
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it.each([true, false])(
    "keeps provider-aware runtime slash lookup with fallback=%s",
    (fallback) => {
      const route = fallbackRoute(selected, active);
      const normalized = normalizedStatus({
        ...(fallback ? route : modelArgs(active.provider, active.model)),
        config: providerModels(
          ["target", "small", { contextWindow: 777_000 }],
          ["source", "large", { contextWindow: 1_048_576 }],
        ),
        sessionEntry: {
          ...(fallback ? route.sessionEntry : {}),
          modelProvider: undefined,
          model: "target/small",
          ...freshUsage(49_000),
        },
      });
      if (fallback) {
        expect(normalized).toContain("Fallback: target/small");
      }
      expect(normalized).toContain("Context: 49k/777k");
      expect(normalized).not.toContain("Context: 49k/200k");
    },
  );
});

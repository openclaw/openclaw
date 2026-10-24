import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { readRecentSessionUsageFromTranscriptAsync } from "../gateway/session-transcript-usage.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { statusModelRefs } from "../status/status-message.test-support.js";
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

type FallbackContextStatusOverrides = {
  activeProvider?: string;
  activeModel?: string;
  activeContextWindow?: number | null;
  runtimeContextTokens?: number;
  sessionContextTokens?: number;
};
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

function makeFallbackContextStatusArgs({
  activeProvider = "minimax-portal",
  activeModel = "MiniMax-M2.7",
  activeContextWindow = 200_000,
  runtimeContextTokens,
  sessionContextTokens,
}: FallbackContextStatusOverrides): Parameters<typeof buildStatusMessage>[0] {
  const providers: Parameters<typeof providerModels> = [
    ["xiaomi", "mimo-v2-flash", { contextWindow: 1_048_576 }],
  ];
  if (activeContextWindow !== null) {
    providers.push([activeProvider, activeModel, { contextWindow: activeContextWindow }]);
  }
  const route = fallbackRoute(
    { provider: "xiaomi", model: "mimo-v2-flash" },
    { provider: activeProvider, model: activeModel },
  );
  return {
    ...route,
    config: providerModels(...providers),
    runtimeContextTokens,
    sessionEntry: {
      ...route.sessionEntry,
      ...freshUsage(49_000),
      ...(sessionContextTokens === undefined
        ? {}
        : {
            contextTokens: sessionContextTokens,
            contextTokensSource: "runtime" as const,
            agentHarnessId: "openclaw" as const,
          }),
    },
    resolvedHarness: "openclaw",
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

it.each<[FallbackContextStatusOverrides, string, string?]>([
  [{ sessionContextTokens: 1_048_576 }, "49k/200k"],
  [
    {
      activeProvider: "custom-runtime",
      activeModel: "unknown-fallback-model",
      activeContextWindow: null,
      sessionContextTokens: 128_000,
    },
    "49k/128k",
    "custom-runtime/unknown-fallback-model",
  ],
  [{ runtimeContextTokens: 123_456, sessionContextTokens: 1_048_576 }, "49k/123k"],
  [{ sessionContextTokens: 123_456 }, "49k/123k"],
])(
  "renders fallback %j with context %s",
  (overrides, context, model = "minimax-portal/MiniMax-M2.7") => {
    const text = normalizedStatus(makeFallbackContextStatusArgs(overrides));
    expect(text).toContain(`Fallback: ${model}`);
    expect(text).toContain(`Context: ${context}`);
    expect(text).not.toContain("Context: 49k/1.0m");
    expect(text.includes("Context: 49k/200k")).toBe(context === "49k/200k");
  },
);

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

it.each<[StatusTestArgs, string, boolean]>([
  [
    {
      agent: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5-mini"],
        },
      },
    },
    "Fallbacks: google/gemini-2.5-flash, openai/gpt-5-mini",
    true,
  ],
  [
    {
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
    },
    "Model: google/gemini-3.1-flash-lite",
    false,
  ],
])("renders configured fallbacks with %j", (args, expected, showFallbacks) => {
  const text = normalizedStatus(args);
  expect(text).toContain(expected);
  expect(text.includes("Fallbacks:")).toBe(showFallbacks);
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
  const firstPage = buildCommandsMessagePaginated(commandConfig, undefined, {
    surface: "telegram",
    page: 1,
    forcePaginatedList: true,
  });
  expect(firstPage.text).toContain("ℹ️ Commands (1/");
  expect(firstPage.text).toContain("Session");
  expect(firstPage.text).toContain("/stop - Stop the current run.");
  const pages = Array.from({ length: firstPage.totalPages }, (_, index) =>
    buildCommandsMessagePaginated(commandConfig, undefined, {
      surface: "telegram",
      page: index + 1,
      forcePaginatedList: true,
    }),
  );
  const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
  if (!pluginPage) {
    throw new Error("expected plugin command page");
  }
  expect(pluginPage.text).toContain("Plugins");
  expect(pluginPage.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
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
      group([
        tool("exec", "Exec", "Run shell commands"),
        tool("web_search", "Web Search", "Search the web"),
      ]),
      group(
        [tool("docs_lookup", "Docs Lookup", "Search internal documentation", "docs")],
        "plugin",
      ),
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
        group([
          {
            ...tool("cron", "Cron", "Schedule and manage cron jobs."),
            rawDescription:
              'Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
          },
        ]),
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
  return { totalTokens, totalTokensFresh: true, totalTokensVersion: 1 as const };
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

  it("reads transcript usage for non-default agents", async () => {
    await withStatusHome(async () => {
      const { render, append } = transcriptFixture({ agentId: "worker1" });
      const args: StatusTestArgs = {
        sessionEntry: runtimeEntry,
        sessionKey: "agent:worker1:telegram:12345",
        resolvedHarness: "openclaw",
      };
      expect(normalizeTestText(await render(args))).toContain("Context: 1.0k/32k");
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
      present: ["Cache: 100% hit · 2.3m cached, 11k new", "Context: 36k/1.0m (4%)"],
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

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withStatusHome(async () => {
      const { render, append } = transcriptFixture();
      append({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: usage(0, 0, 0, 0),
      });

      const text = await render({
        sessionEntry: runtimeEntry,
        resolvedHarness: "openclaw",
        sessionKey: "agent:main:main",
      });

      expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
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

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    const route = fallbackRoute(
      { provider: "xiaomi", model: "mimo-v2-flash" },
      { provider: "fake-minimax", model: "FakeMiniMax-M2.5" },
    );
    const text = buildStatusMessage({
      ...route,
      config: providerModels(
        ["fake-minimax", "FakeMiniMax-M2.5", { contextWindow: 777_000 }],
        ["xiaomi", "mimo-v2-flash", { contextWindow: 1_048_576 }],
      ),
      sessionEntry: {
        ...route.sessionEntry,
        modelProvider: undefined,
        model: "fake-minimax/FakeMiniMax-M2.5",
        ...freshUsage(49_000),
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    const text = buildStatusMessage({
      ...modelArgs("openai", "gpt-4o"),
      config: providerModels(["openai", "gpt-4o", { contextWindow: 777_000 }]),
      sessionEntry: {
        model: "openai/gpt-4o",
        ...freshUsage(49_000),
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
  });
});

import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  createNativeModelCatalog,
  createNativeSlashFixture,
  nativeCommand,
} from "./get-reply-native-slash-fast-path.test-fixtures.js";
import { buildTestCtx } from "./test-ctx.js";

const { handleCommandsMock, buildStatusReplyMock } = vi.hoisted(() => ({
  handleCommandsMock: vi.fn(),
  buildStatusReplyMock: vi.fn(),
}));

// Runtime eligibility belongs to the published-owner tests; these cases exercise its consumers.
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<
    typeof import("../../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "openclaw",
    validate: () => undefined,
  })),
}));

vi.mock("./commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands.js")>()),
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(root);
      closeOpenClawAgentDatabasesForTest(root);
    }
    cleanup();
  }),
);
afterEach(() => cliBackendsTesting.resetDepsForTest());

const runtimeCliBackends = [
  {
    id: "claude-cli",
    modelProvider: "anthropic",
    pluginId: "anthropic",
    config: { command: "claude" },
    bundleMcp: false,
  },
];

let fixture: ReturnType<typeof createNativeSlashFixture>;
let storePath: string;

function buildTextCommandCtx(provider: string, overrides: Parameters<typeof buildTestCtx>[0]) {
  const body = "/export-trajectory bundle";
  return buildTestCtx({
    Body: body,
    BodyForCommands: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: provider,
    Surface: provider,
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "export-trajectory",
      body,
    },
    ...overrides,
  });
}

function expectDelivery(
  result: Awaited<ReturnType<typeof maybeResolveNativeSlashCommandFastReply>>,
) {
  if (!result.handled || !result.reply || Array.isArray(result.reply)) {
    throw new Error("expected single handled reply");
  }
  expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
}

type ModelSelectionCase = {
  command?: string;
  source: "auto" | "user";
  locked: boolean;
  expectedProvider: string;
  activeFallback?: boolean;
  transportAuthorized?: boolean;
  approvedByPolicy?: boolean;
  allowed?: string[];
  agentAllowed?: string[];
  targetAgentId?: string;
  agentCap?: number;
  overrideProvider?: string;
  overrideModel?: string;
};

beforeEach(() => {
  vi.restoreAllMocks();
  storePath = path.join(tempDirs.make("openclaw-native-"), "sessions.json");
  fixture = createNativeSlashFixture(storePath, maybeResolveNativeSlashCommandFastReply);
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => runtimeCliBackends,
    resolvePluginSetupCliBackend: () => {
      throw new Error("native command attempted synchronous CLI setup discovery");
    },
  });
  // Keep scoped thinking reads on the same catalog fixture as model selection.
  const catalogSnapshot: ModelCatalogSnapshot = {
    entries: createNativeModelCatalog(),
    routeVariants: [],
  };
  vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue(
    catalogSnapshot,
  );
  vi.spyOn(preparedModelCatalog, "loadProviderScopedThinkingCatalog").mockResolvedValue(
    catalogSnapshot.entries,
  );
  handleCommandsMock.mockReset();
  buildStatusReplyMock.mockReset().mockResolvedValue({ text: "selected model status" });
});

async function resolveNativeDirectiveCommand(
  body: string,
  config?: OpenClawConfig,
  response: { shouldContinue: boolean; reply?: { text: string } } = { shouldContinue: true },
  preparedCatalog?: ModelCatalogSnapshot,
) {
  handleCommandsMock.mockResolvedValue(response);
  const result = await fixture.run({
    ctx: nativeCommand(body, {
      BodyForAgent: body,
      RawBody: body,
      Provider: "telegram",
      Surface: "telegram",
      GatewayClientScopes: ["operator.admin"],
      SessionKey: "telegram:slash:123",
      CommandTargetSessionKey: "agent:main:telegram:123",
    }),
    cfg: fixture.config(config),
    agentCfg: config?.agents?.defaults,
    preparedModelCatalog: preparedCatalog,
  });

  return { result };
}

it.each([
  ["/queue Can you diagnose this?", 'Unrecognized queue mode "Can".'],
  ["/think about my deployment plan", 'Unrecognized thinking level "about".'],
  ["/verbose explain quantum computing", 'Unrecognized verbose level "explain".'],
  ["/trace banana please", 'Unrecognized trace level "banana".'],
  ["/fast bananas please", 'Unrecognized fast mode "bananas".'],
  ["/reasoning nonsense please", 'Unrecognized reasoning level "nonsense".'],
  ["/queue collect please help", 'Unexpected argument "please" for /queue.', true],
  ["/exec host=node please", 'Unexpected argument "please" for /exec.', true],
  ["/model openai/gpt-5.5 -slow", 'Unexpected argument "-slow" for /model.', true],
] as const)(
  "validates native directive arguments: %s",
  async (command, expected, exact = false) => {
    const { result } = await resolveNativeDirectiveCommand(command);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: exact ? expected : expect.stringContaining(expected),
      }),
    });
  },
);

it.each<{
  command: string;
  config?: OpenClawConfig;
  catalog?: ModelCatalogSnapshot;
  entry: Partial<SessionEntry>;
  text: string | ReturnType<typeof expect.stringContaining>;
}>([
  {
    command: "/exec host=node node=worker-1",
    entry: { execHost: "node", execNode: "worker-1" },
    text: expect.stringContaining("Exec defaults set (host=node, node=worker-1)."),
  },
  {
    command: "/model openai/gpt-5.5 --runtime codex -s",
    config: { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
    entry: { agentRuntimeOverride: "codex" },
    text: "Session model reset to configured default (openai/gpt-5.5). Runtime set to codex for this session.",
  },
  {
    command: "/model ollama/picker-secondary -s",
    catalog: {
      entries: [
        {
          provider: "ollama",
          id: "picker-secondary",
          name: "Picker secondary",
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          reasoning: false,
          contextWindow: 32768,
        },
      ],
      routeVariants: [],
    },
    entry: { providerOverride: "ollama", modelOverride: "picker-secondary" },
    text: expect.stringContaining("ollama/picker-secondary"),
  },
])("persists native selection: $command", async ({ command, config, catalog, entry, text }) => {
  if (catalog) {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.mocked(preparedModelCatalog.loadPreparedModelCatalogSnapshot).mockRejectedValue(
      new Error("native selection must not rediscover the prepared catalog"),
    );
  }
  const { result } = await resolveNativeDirectiveCommand(
    command,
    config,
    { shouldContinue: true },
    catalog,
  );
  expect(result).toMatchObject({ handled: true, reply: { text } });
  expect(fixture.readExact()?.entry).toMatchObject(entry);
  if (catalog) {
    expect(preparedModelCatalog.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(preparedModelCatalog.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  }
});

it("renders native status thinking for the pinned model and target agent", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => runtimeCliBackends,
    resolvePluginSetupCliBackend: ({ backend }) => {
      if (backend === "fixture" || backend === "openai") {
        return undefined;
      }
      throw new Error(`unexpected native status CLI backend lookup: ${backend}`);
    },
    resolvePluginSetupRegistry: () => {
      throw new Error("native status must not load the full CLI setup registry");
    },
  });
  const { buildStatusReplyParts } = await import("../../status/status-text.js");
  buildStatusReplyMock.mockImplementation(
    async (params: Parameters<typeof buildStatusReplyParts>[0]) =>
      buildStatusReplyParts({
        ...params,
        statusChannel: "telegram",
        resolvedHarness: "openclaw",
        pluginHealthLineOverride: "Plugins: test",
        modelAuthOverride: "api-key",
        activeModelAuthOverride: "api-key",
        includeTranscriptUsage: false,
      }),
  );
  vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue([
    { provider: "openai", id: "gpt-5.5", name: "Default model", reasoning: false },
    { provider: "fixture", id: "selected-model", name: "Selected model", reasoning: true },
  ]);
  const sessionKey = "agent:main:telegram:123";
  await fixture.write(
    {
      sessionId: "pinned-model",
      updatedAt: Date.now(),
      providerOverride: "fixture",
      modelOverride: "selected-model",
      modelOverrideSource: "user",
    },
    sessionKey,
  );

  const { result } = await resolveNativeDirectiveCommand("/status", {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        models: {
          "openai/gpt-5.5": { params: { thinking: "off" } },
          "fixture/selected-model": { params: { thinking: "low" } },
        },
      },
      entries: {
        main: { models: { "fixture/selected-model": { params: { thinking: "high" } } } },
      },
    },
  });

  expect(result).toMatchObject({
    handled: true,
    reply: { text: expect.stringContaining("think high") },
  });
  const entry = fixture.readExact(sessionKey)?.entry;
  expect(entry).toMatchObject({
    providerOverride: "fixture",
    modelOverride: "selected-model",
  });
  expect(entry?.thinkingLevel).toBeUndefined();
});

it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
  const reply = {
    text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k",
  };
  const { result } = await resolveNativeDirectiveCommand("/compact", undefined, {
    shouldContinue: false,
    reply,
  });

  expect(result).toMatchObject({ handled: true, reply });
  expectDelivery(result);
});

it.each<ModelSelectionCase>([
  { command: "/context json", source: "user", locked: false, expectedProvider: "anthropic" },
  { source: "auto" as const, locked: false, expectedProvider: "openai" },
  { source: "auto" as const, locked: false, activeFallback: true, expectedProvider: "anthropic" },
  {
    source: "user" as const,
    locked: false,
    transportAuthorized: false,
    approvedByPolicy: true,
    expectedProvider: "anthropic",
  },
  {
    source: "user" as const,
    locked: true,
    allowed: ["openai/*"],
    expectedProvider: "anthropic",
  },
  {
    source: "user" as const,
    locked: false,
    allowed: ["openai/*"],
    agentAllowed: ["anthropic/claude-fable-5"],
    targetAgentId: "target",
    agentCap: 120_000,
    overrideProvider: "openai",
    overrideModel: "gpt-5.5",
    expectedProvider: "openai",
  },
])(
  "resolves native model context ($source, locked=$locked, command=$command)",
  async (testCase) => {
    const { source, locked, expectedProvider, command = "/compact" } = testCase;
    const contextCommand = command === "/context json";
    const transportAuthorized = testCase.transportAuthorized ?? true;
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: contextCommand ? "⚙️ Compacted" : "compacted" },
    });
    const targetAgentId = testCase.targetAgentId ?? "main";
    const targetSessionKey = `agent:${targetAgentId}:main`;
    await fixture.write(
      {
        sessionId: contextCommand ? "fable-session" : "selected-session",
        ...(contextCommand ? { agentRuntimeOverride: "claude-cli" } : {}),
        updatedAt: Date.now(),
        providerOverride: testCase.overrideProvider ?? "anthropic",
        modelOverride: testCase.overrideModel ?? "claude-fable-5",
        modelOverrideSource: source,
        modelSelectionLocked: locked,
        contextTokens: 1_000_000,
        thinkingLevel: "off",
        ...(testCase.activeFallback !== undefined
          ? {
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: "gpt-5.5",
            }
          : {}),
      },
      targetSessionKey,
      targetAgentId,
    );

    const config: OpenClawConfig = {};
    if (testCase.approvedByPolicy) {
      config.commands = { allowFrom: { "*": ["approved-sender"] } };
    }
    if (testCase.allowed) {
      config.agents = {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          modelPolicy: { allow: testCase.allowed },
        },
      };
      if (testCase.agentAllowed) {
        config.agents.entries = {
          [targetAgentId]: {
            modelPolicy: { allow: testCase.agentAllowed },
            contextTokens: testCase.agentCap,
          },
        };
      }
    }
    const result = await fixture.run({
      ctx: nativeCommand(command, {
        ...(contextCommand
          ? {}
          : {
              CommandAuthorized: transportAuthorized,
              Provider: "telegram",
              Surface: "telegram",
              From: "telegram:approved-sender",
              SenderId: "approved-sender",
            }),
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      cfg: fixture.config(config, { runtimeMode: "full" }),
      agentId: targetAgentId,
      commandAuthorized: transportAuthorized,
    });

    expect(result.handled).toBe(true);
    if (contextCommand) {
      expect(handleCommandsMock).toHaveBeenCalledOnce();
      expect(fixture.typing.cleanup).toHaveBeenCalledOnce();
    }
    expect(handleCommandsMock.mock.calls[0]?.[0]).toMatchObject({
      provider: expectedProvider,
      model: contextCommand
        ? expect.stringMatching(/claude-fable-5/)
        : expectedProvider === "openai"
          ? "gpt-5.5"
          : "claude-fable-5",
      contextTokens: expectedProvider === "openai" ? 200_000 : 1_000_000,
    });
  },
);

it.each(["webchat", "telegram"])(
  "routes %s text slash commands before model dispatch",
  async (provider) => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });
    const internal = provider === "webchat";
    const result = await fixture.run({
      ctx: buildTextCommandCtx(
        provider,
        internal
          ? { SessionKey: "agent:dev:webchat", OriginatingChannel: "webchat", ChatType: "direct" }
          : { SessionKey: "agent:dev:telegram:group:123", ChatType: "group" },
      ),
      agentId: "dev",
    });
    if (internal) {
      expect(handleCommandsMock).toHaveBeenCalledOnce();
      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({ text: "Trajectory exports can include prompts." }),
      });
      expectDelivery(result);
      expect(fixture.typing.cleanup).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ handled: false });
      expect(handleCommandsMock).not.toHaveBeenCalled();
      expect(fixture.typing.cleanup).not.toHaveBeenCalled();
    }
  },
);

it.each([
  { commandName: "config show", authorized: false },
  { commandName: "compact", authorized: true, deniedByPolicy: true },
])("rejects unauthorized native /$commandName before model selection", async (testCase) => {
  const { commandName, authorized } = testCase;
  const sessionKey = "agent:main:telegram:slash:unauthorized";
  handleCommandsMock.mockResolvedValueOnce({
    shouldContinue: false,
    reply: { text: "You are not authorized to use this command." },
  });

  const result = await fixture.run({
    ctx: nativeCommand(`/${commandName}`, {
      CommandAuthorized: authorized,
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:denied-sender",
      SenderId: "denied-sender",
      CommandTargetSessionKey: sessionKey,
    }),
    cfg: fixture.config(
      ("deniedByPolicy" in testCase
        ? { commands: { allowFrom: { "*": ["approved-sender"] } } }
        : {}) as OpenClawConfig,
    ),
    commandAuthorized: authorized,
  });

  expect(result).toEqual({
    handled: true,
    reply: expect.objectContaining({ text: "You are not authorized to use this command." }),
  });
  expect(handleCommandsMock).toHaveBeenCalledOnce();
  expect(handleCommandsMock.mock.calls[0]?.[0]).toMatchObject({
    provider: "openai",
    model: "gpt-5.5",
    command: { isAuthorizedSender: false },
  });
  if (!authorized) {
    expect(fixture.readExact(sessionKey)).toBeUndefined();
  }
});

it("does not mutate an archived session during native command initialization", async () => {
  const sessionKey = "agent:main:main";
  const archivedEntry = {
    sessionId: "archived-session",
    updatedAt: 1,
    lastInteractionAt: 1,
    archivedAt: 2,
    channel: "telegram",
  };
  await fixture.write(archivedEntry as SessionEntry, sessionKey);
  const persistedArchivedEntry = fixture.readExact(sessionKey)?.entry;

  const result = await fixture.run({
    ctx: nativeCommand("/compact", {
      Provider: "telegram",
      CommandTargetSessionKey: sessionKey,
    }),
  });

  expect(result).toEqual({
    handled: true,
    reply: expect.objectContaining({ text: expect.stringContaining("is archived") }),
  });
  expectDelivery(result);
  expect(handleCommandsMock).not.toHaveBeenCalled();
  expect(fixture.readExact(sessionKey)?.entry).toEqual(persistedArchivedEntry);
});

it("persists fast-path session initialization before command mutation", async () => {
  const sessionKey = "agent:main:main";
  await fixture.write(
    {
      sessionId: "session-1",
      updatedAt: 1,
      lastInteractionAt: 1,
      channel: "old-channel",
    } as SessionEntry,
    sessionKey,
  );
  handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
    const persisted = fixture.read(sessionKey);
    const initialized = {
      sessionId: "session-1",
      sessionStartedAt: 100,
      updatedAt: 100,
      lastInteractionAt: 100,
      channel: "telegram",
    };
    expect(params.sessionEntry).toMatchObject(initialized);
    expect(persisted).toMatchObject(initialized);
    return { shouldContinue: false, reply: { text: "ok" } };
  });
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100);

  try {
    await fixture.run({
      ctx: nativeCommand("/compact", {
        Provider: "telegram",
        CommandTargetSessionKey: sessionKey,
      }),
    });
  } finally {
    nowSpy.mockRestore();
  }

  expect(handleCommandsMock).toHaveBeenCalledTimes(1);
});

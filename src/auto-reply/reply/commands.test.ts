import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../pairing/pairing-store.js")>(
    "../../pairing/pairing-store.js",
  );
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
    removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
  };
});

vi.mock("../../channels/plugins/pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/pairing.js")>(
    "../../channels/plugins/pairing.js",
  );
  return {
    ...actual,
    listPairingChannels: () => ["telegram"],
  };
});

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]),
}));

vi.mock("../../agents/pi-embedded.js", () => {
  const resolveEmbeddedSessionLane = (key: string) => {
    const cleaned = key.trim() || "main";
    return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
  };
  return {
    abortEmbeddedPiRun: vi.fn(),
    compactEmbeddedPiSession: vi.fn(),
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveEmbeddedSessionLane,
    runEmbeddedPiAgent: vi.fn(),
    waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(),
}));

const callGatewayMock = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

import type { HandleCommandsParams } from "./commands-types.js";

// Avoid expensive workspace scans during /context tests.
vi.mock("./commands-context-report.js", () => ({
  buildContextReply: async (params: { command: { commandBodyNormalized: string } }) => {
    const normalized = params.command.commandBodyNormalized;
    if (normalized === "/context list") {
      return { text: "Injected workspace files:\n- AGENTS.md" };
    }
    if (normalized === "/context detail") {
      return { text: "Context breakdown (detailed)\nTop tools (schema size):" };
    }
    return { text: "/context\n- /context list\nInline shortcut" };
  },
}));

vi.resetModules();

const { addSubagentRunForTests, listSubagentRunsForRequester, resetSubagentRegistryForTests } =
  await import("../../agents/subagent-registry.js");
const { setDefaultChannelPluginRegistryForTests } =
  await import("../../commands/channel-test-helpers.js");
const internalHooks = await import("../../hooks/internal-hooks.js");
const { clearPluginCommands, registerPluginCommand } = await import("../../plugins/commands.js");
const { abortEmbeddedPiRun, compactEmbeddedPiSession } =
  await import("../../agents/pi-embedded.js");
const { resetBashChatCommandForTests } = await import("./bash-command.js");
const { handleCompactCommand } = await import("./commands-compact.js");
const { buildCommandsPaginationKeyboard } = await import("./commands-info.js");
const { extractMessageText } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { parseConfigCommand } = await import("./config-commands.js");
const { parseDebugCommand } = await import("./debug-commands.js");
const { parseInlineDirectives } = await import("./directive-handling.js");
const { buildCommandContext, handleCommands } = await import("./commands.js");

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commands-"));
  await fs.writeFile(path.join(testWorkspaceDir, "AGENTS.md"), "# Agents\n", "utf-8");
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, { recursive: true, force: true });
});

beforeEach(() => {
  setDefaultChannelPluginRegistryForTests();
  readConfigFileSnapshotMock.mockImplementation(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      return { valid: false, parsed: null };
    }
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    return { valid: true, parsed };
  });
  validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
    ok: true,
    config,
  }));
  writeConfigFileMock.mockImplementation(async (config: unknown) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      return;
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  });
  readChannelAllowFromStoreMock.mockResolvedValue([]);
  addChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
  removeChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
});

async function withTempConfigPath<T>(
  initialConfig: Record<string, unknown>,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commands-config-"));
  const configPath = path.join(dir, "openclaw.json");
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf-8");
  try {
    return await run(configPath);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

function buildParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>) {
  return buildCommandTestParams(commandBody, cfg, ctxOverrides, { workspaceDir: testWorkspaceDir });
}

describe("handleCommands gating", () => {
  it("blocks gated commands when disabled or not elevated-allowlisted", async () => {
    const cases = typedCases<{
      name: string;
      commandBody: string;
      makeCfg: () => OpenClawConfig;
      applyParams?: (params: ReturnType<typeof buildParams>) => void;
      expectedText: string;
    }>([
      {
        name: "disabled bash command",
        commandBody: "/bash echo hi",
        makeCfg: () =>
          ({
            commands: { bash: false, text: true },
            whatsapp: { allowFrom: ["*"] },
          }) as OpenClawConfig,
        expectedText: "bash is disabled",
      },
      {
        name: "missing elevated allowlist",
        commandBody: "/bash echo hi",
        makeCfg: () =>
          ({
            commands: { bash: true, text: true },
            whatsapp: { allowFrom: ["*"] },
          }) as OpenClawConfig,
        applyParams: (params: ReturnType<typeof buildParams>) => {
          params.elevated = {
            enabled: true,
            allowed: false,
            failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
          };
        },
        expectedText: "elevated is not available",
      },
      {
        name: "disabled config command",
        commandBody: "/config show",
        makeCfg: () =>
          ({
            commands: { config: false, debug: false, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          }) as OpenClawConfig,
        applyParams: (params: ReturnType<typeof buildParams>) => {
          params.command.senderIsOwner = true;
        },
        expectedText: "/config is disabled",
      },
      {
        name: "disabled debug command",
        commandBody: "/debug show",
        makeCfg: () =>
          ({
            commands: { config: false, debug: false, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          }) as OpenClawConfig,
        applyParams: (params: ReturnType<typeof buildParams>) => {
          params.command.senderIsOwner = true;
        },
        expectedText: "/debug is disabled",
      },
      {
        name: "inherited bash flag does not enable command",
        commandBody: "/bash echo hi",
        makeCfg: () => {
          const inheritedCommands = Object.create({
            bash: true,
            config: true,
            debug: true,
          }) as Record<string, unknown>;
          return {
            commands: inheritedCommands as never,
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig;
        },
        expectedText: "bash is disabled",
      },
      {
        name: "inherited config flag does not enable command",
        commandBody: "/config show",
        makeCfg: () => {
          const inheritedCommands = Object.create({
            bash: true,
            config: true,
            debug: true,
          }) as Record<string, unknown>;
          return {
            commands: inheritedCommands as never,
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig;
        },
        applyParams: (params: ReturnType<typeof buildParams>) => {
          params.command.senderIsOwner = true;
        },
        expectedText: "/config is disabled",
      },
      {
        name: "inherited debug flag does not enable command",
        commandBody: "/debug show",
        makeCfg: () => {
          const inheritedCommands = Object.create({
            bash: true,
            config: true,
            debug: true,
          }) as Record<string, unknown>;
          return {
            commands: inheritedCommands as never,
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig;
        },
        applyParams: (params: ReturnType<typeof buildParams>) => {
          params.command.senderIsOwner = true;
        },
        expectedText: "/debug is disabled",
      },
    ]);

    for (const testCase of cases) {
      resetBashChatCommandForTests();
      const params = buildParams(testCase.commandBody, testCase.makeCfg());
      testCase.applyParams?.(params);
      const result = await handleCommands(params);
      expect(result.shouldContinue, testCase.name).toBe(false);
      expect(result.reply?.text, testCase.name).toContain(testCase.expectedText);
    }
  });
});

describe("/approve command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTelegramApproveCfg(
    execApprovals: {
      enabled: true;
      approvers: string[];
      target: "dm";
    } | null = { enabled: true, approvers: ["123"], target: "dm" },
  ): OpenClawConfig {
    return {
      commands: { text: true },
      channels: {
        telegram: {
          allowFrom: ["*"],
          ...(execApprovals ? { execApprovals } : {}),
        },
      },
    } as OpenClawConfig;
  }

  it("rejects invalid usage", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/approve", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /approve");
  });

  it("submits approval", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/approve abc allow-once", cfg, { SenderId: "123" });

    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });

  it("accepts Telegram command mentions for /approve", async () => {
    const cfg = createTelegramApproveCfg();
    const params = buildParams("/approve@bot abc12345 allow-once", cfg, {
      BotUsername: "bot",
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "123",
    });

    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc12345", decision: "allow-once" },
      }),
    );
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const testCase of [
      {
        name: "different bot mention",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve@otherbot abc12345 allow-once",
        ctx: {
          BotUsername: "bot",
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: undefined,
        expectedText: "targets a different Telegram bot",
        expectGatewayCalls: 0,
      },
      {
        name: "unknown approval id",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: () => callGatewayMock.mockRejectedValue(new Error("unknown or expired approval id")),
        expectedText: "unknown or expired approval id",
        expectGatewayCalls: 1,
      },
      {
        name: "telegram approvals disabled",
        cfg: createTelegramApproveCfg(null),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: undefined,
        expectedText: "Telegram exec approvals are not enabled",
        expectGatewayCalls: 0,
      },
      {
        name: "non approver",
        cfg: createTelegramApproveCfg({ enabled: true, approvers: ["999"], target: "dm" }),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: undefined,
        expectedText: "not authorized to approve",
        expectGatewayCalls: 0,
      },
    ] as const) {
      callGatewayMock.mockReset();
      testCase.setup?.();
      const params = buildParams(testCase.commandBody, testCase.cfg, testCase.ctx);

      const result = await handleCommands(params);
      expect(result.shouldContinue, testCase.name).toBe(false);
      expect(result.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectGatewayCalls);
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    const cases = [
      {
        scopes: ["operator.write"],
        expectedText: "requires operator.approvals",
        expectedGatewayCalls: 0,
      },
      {
        scopes: ["operator.approvals"],
        expectedText: "Exec approval allow-once submitted",
        expectedGatewayCalls: 1,
      },
      {
        scopes: ["operator.admin"],
        expectedText: "Exec approval allow-once submitted",
        expectedGatewayCalls: 1,
      },
    ] as const;
    for (const testCase of cases) {
      callGatewayMock.mockReset();
      callGatewayMock.mockResolvedValue({ ok: true });
      const params = buildParams("/approve abc allow-once", cfg, {
        Provider: "webchat",
        Surface: "webchat",
        GatewayClientScopes: [...testCase.scopes],
      });

      const result = await handleCommands(params);
      expect(result.shouldContinue, String(testCase.scopes)).toBe(false);
      expect(result.reply?.text, String(testCase.scopes)).toContain(testCase.expectedText);
      expect(callGatewayMock, String(testCase.scopes)).toHaveBeenCalledTimes(
        testCase.expectedGatewayCalls,
      );
      if (testCase.expectedGatewayCalls > 0) {
        expect(callGatewayMock, String(testCase.scopes)).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: "exec.approval.resolve",
            params: { id: "abc", decision: "allow-once" },
          }),
        );
      }
    }
  });
});

describe("/compact command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when command is not /compact", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/status", cfg);

    const result = await handleCompactCommand(
      {
        ...params,
      },
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/compact", cfg);

    const result = await handleCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      },
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/openclaw-session-store.json" },
    } as OpenClawConfig;
    const params = buildParams("/compact: focus on decisions", cfg, {
      From: "+15550001",
      To: "+15550002",
    });
    const agentDir = "/tmp/openclaw-agent-compact";
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      {
        ...params,
        agentDir,
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
        },
      },
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        allowGatewaySubagentBinding: true,
        trigger: "manual",
        customInstructions: "focus on decisions",
        messageChannel: "whatsapp",
        groupId: "group-1",
        groupChannel: "#general",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        agentDir,
      }),
    );
  });
});

describe("abort trigger command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthorized natural-language abort triggers", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("stop", cfg);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortedLastRun: false,
    };
    const sessionStore: Record<string, SessionEntry> = {
      [params.sessionKey]: sessionEntry,
    };

    const result = await handleCommands({
      ...params,
      sessionEntry,
      sessionStore,
      command: {
        ...params.command,
        isAuthorizedSender: false,
        senderId: "unauthorized",
      },
    });

    expect(result).toEqual({ shouldContinue: false });
    expect(sessionStore[params.sessionKey]?.abortedLastRun).toBe(false);
    expect(vi.mocked(abortEmbeddedPiRun)).not.toHaveBeenCalled();
  });
});

describe("buildCommandsPaginationKeyboard", () => {
  it("adds agent id to callback data when provided", () => {
    const keyboard = buildCommandsPaginationKeyboard(2, 3, "agent-main");
    expect(keyboard[0]).toEqual([
      { text: "◀ Prev", callback_data: "commands_page_1:agent-main" },
      { text: "2/3", callback_data: "commands_page_noop:agent-main" },
      { text: "Next ▶", callback_data: "commands_page_3:agent-main" },
    ]);
  });
});

describe("parseConfigCommand", () => {
  it("parses config/debug command actions and JSON payloads", () => {
    const cases: Array<{
      parse: (input: string) => unknown;
      input: string;
      expected: unknown;
    }> = [
      { parse: parseConfigCommand, input: "/config", expected: { action: "show" } },
      {
        parse: parseConfigCommand,
        input: "/config show",
        expected: { action: "show", path: undefined },
      },
      {
        parse: parseConfigCommand,
        input: "/config show foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config get foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: '/config set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
      { parse: parseDebugCommand, input: "/debug", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug show", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug reset", expected: { action: "reset" } },
      {
        parse: parseDebugCommand,
        input: "/debug unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseDebugCommand,
        input: '/debug set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
    ];

    for (const testCase of cases) {
      expect(testCase.parse(testCase.input)).toEqual(testCase.expected);
    }
  });
});

describe("extractMessageText", () => {
  it("preserves user markers and sanitizes assistant markers", () => {
    const cases = [
      {
        message: { role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here [Tool Call: foo (ID: 1)] ok",
      },
      {
        message: { role: "assistant", content: "Here [Tool Call: foo (ID: 1)] ok" },
        expectedText: "Here ok",
      },
    ] as const;

    for (const testCase of cases) {
      const result = extractMessageText(testCase.message);
      expect(result?.text).toBe(testCase.expectedText);
    }
  });
});

describe("handleCommands owner gating for privileged show commands", () => {
  it("enforces owner gating for /config show and /debug show", async () => {
    const cases = [
      {
        name: "/config show blocks authorized non-owner senders",
        build: () => {
          const params = buildParams("/config show", {
            commands: { config: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig);
          params.command.senderIsOwner = false;
          return params;
        },
        assert: (result: Awaited<ReturnType<typeof handleCommands>>) => {
          expect(result.shouldContinue).toBe(false);
          expect(result.reply).toBeUndefined();
        },
      },
      {
        name: "/config show stays available for owners",
        build: () => {
          readConfigFileSnapshotMock.mockResolvedValueOnce({
            valid: true,
            parsed: { messages: { ackReaction: ":)" } },
          });
          const params = buildParams("/config show messages.ackReaction", {
            commands: { config: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig);
          params.command.senderIsOwner = true;
          return params;
        },
        assert: (result: Awaited<ReturnType<typeof handleCommands>>) => {
          expect(result.shouldContinue).toBe(false);
          expect(result.reply?.text).toContain("Config messages.ackReaction");
        },
      },
      {
        name: "/debug show blocks authorized non-owner senders",
        build: () => {
          const params = buildParams("/debug show", {
            commands: { debug: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig);
          params.command.senderIsOwner = false;
          return params;
        },
        assert: (result: Awaited<ReturnType<typeof handleCommands>>) => {
          expect(result.shouldContinue).toBe(false);
          expect(result.reply).toBeUndefined();
        },
      },
      {
        name: "/debug show stays available for owners",
        build: () => {
          const params = buildParams("/debug show", {
            commands: { debug: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig);
          params.command.senderIsOwner = true;
          return params;
        },
        assert: (result: Awaited<ReturnType<typeof handleCommands>>) => {
          expect(result.shouldContinue).toBe(false);
          expect(result.reply?.text).toContain("Debug overrides");
        },
      },
    ] as const;

    for (const testCase of cases) {
      const result = await handleCommands(testCase.build());
      testCase.assert(result);
    }
  });
});

describe("handleCommands /config configWrites gating", () => {
  it("blocks disallowed /config set writes", async () => {
    const cases = [
      {
        name: "channel config writes disabled",
        params: (() => {
          const params = buildParams('/config set messages.ackReaction=":)"', {
            commands: { config: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"], configWrites: false } },
          } as OpenClawConfig);
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "Config writes are disabled",
      },
      {
        name: "target account disables writes",
        params: (() => {
          const params = buildPolicyParams(
            "/config set channels.telegram.accounts.work.enabled=false",
            {
              commands: { config: true, text: true },
              channels: {
                telegram: {
                  configWrites: true,
                  accounts: {
                    work: { configWrites: false, enabled: true },
                  },
                },
              },
            } as OpenClawConfig,
            {
              AccountId: "default",
              Provider: "telegram",
              Surface: "telegram",
            },
          );
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "channels.telegram.accounts.work.configWrites=true",
      },
      {
        name: "ambiguous channel-root write",
        params: (() => {
          const params = buildPolicyParams(
            '/config set channels.telegram={"enabled":false}',
            {
              commands: { config: true, text: true },
              channels: { telegram: { configWrites: true } },
            } as OpenClawConfig,
            {
              Provider: "telegram",
              Surface: "telegram",
            },
          );
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "cannot replace channels, channel roots, or accounts collections",
      },
    ] as const;

    for (const testCase of cases) {
      const previousWriteCount = writeConfigFileMock.mock.calls.length;
      const result = await handleCommands(testCase.params);
      expect(result.shouldContinue, testCase.name).toBe(false);
      expect(result.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(writeConfigFileMock.mock.calls.length, testCase.name).toBe(previousWriteCount);
    }
  });

  it("enforces gateway client permissions for /config commands", async () => {
    const baseCfg = {
      commands: { config: true, text: true },
    } as OpenClawConfig;
    const cases = [
      {
        name: "blocks /config set from gateway clients without operator.admin",
        run: async () => {
          const params = buildParams('/config set messages.ackReaction=":)"', baseCfg, {
            Provider: INTERNAL_MESSAGE_CHANNEL,
            Surface: INTERNAL_MESSAGE_CHANNEL,
            GatewayClientScopes: ["operator.write"],
          });
          params.command.channel = INTERNAL_MESSAGE_CHANNEL;
          params.command.senderIsOwner = true;
          const result = await handleCommands(params);
          expect(result.shouldContinue).toBe(false);
          expect(result.reply?.text).toContain("requires operator.admin");
        },
      },
      {
        name: "keeps /config show available to gateway operator.write clients",
        run: async () => {
          readConfigFileSnapshotMock.mockResolvedValueOnce({
            valid: true,
            parsed: { messages: { ackReaction: ":)" } },
          });
          const params = buildParams("/config show messages.ackReaction", baseCfg, {
            Provider: INTERNAL_MESSAGE_CHANNEL,
            Surface: INTERNAL_MESSAGE_CHANNEL,
            GatewayClientScopes: ["operator.write"],
          });
          params.command.channel = INTERNAL_MESSAGE_CHANNEL;
          params.command.senderIsOwner = false;
          const result = await handleCommands(params);
          expect(result.shouldContinue).toBe(false);
          expect(result.reply?.text).toContain("Config messages.ackReaction");
        },
      },
      {
        name: "keeps /config set working for gateway operator.admin clients",
        run: async () => {
          await withTempConfigPath({ messages: { ackReaction: ":)" } }, async (configPath) => {
            readConfigFileSnapshotMock.mockResolvedValueOnce({
              valid: true,
              parsed: { messages: { ackReaction: ":)" } },
            });
            validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
              ok: true,
              config,
            }));
            const params = buildParams('/config set messages.ackReaction=":D"', baseCfg, {
              Provider: INTERNAL_MESSAGE_CHANNEL,
              Surface: INTERNAL_MESSAGE_CHANNEL,
              GatewayClientScopes: ["operator.write", "operator.admin"],
            });
            params.command.channel = INTERNAL_MESSAGE_CHANNEL;
            params.command.senderIsOwner = true;
            const result = await handleCommands(params);
            expect(result.shouldContinue).toBe(false);
            expect(result.reply?.text).toContain("Config updated");
            const written = await readJsonFile<OpenClawConfig>(configPath);
            expect(written.messages?.ackReaction).toBe(":D");
          });
        },
      },
      {
        name: "keeps /config set working for gateway operator.admin on protected account paths",
        run: async () => {
          const initialConfig = {
            channels: {
              telegram: {
                accounts: {
                  work: { enabled: true, configWrites: false },
                },
              },
            },
          };
          await withTempConfigPath(initialConfig, async (configPath) => {
            readConfigFileSnapshotMock.mockResolvedValueOnce({
              valid: true,
              parsed: structuredClone(initialConfig),
            });
            validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
              ok: true,
              config,
            }));
            const params = buildParams(
              "/config set channels.telegram.accounts.work.enabled=false",
              {
                commands: { config: true, text: true },
                channels: {
                  telegram: {
                    accounts: {
                      work: { enabled: true, configWrites: false },
                    },
                  },
                },
              } as OpenClawConfig,
              {
                Provider: INTERNAL_MESSAGE_CHANNEL,
                Surface: INTERNAL_MESSAGE_CHANNEL,
                GatewayClientScopes: ["operator.write", "operator.admin"],
              },
            );
            params.command.channel = INTERNAL_MESSAGE_CHANNEL;
            params.command.senderIsOwner = true;
            const result = await handleCommands(params);
            expect(result.shouldContinue).toBe(false);
            expect(result.reply?.text).toContain("Config updated");
            const written = await readJsonFile<OpenClawConfig>(configPath);
            expect(written.channels?.telegram?.accounts?.work?.enabled).toBe(false);
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });
});

describe("handleCommands bash alias", () => {
  it.each(["![image](https://example.com/img.png)", "![](url)", "![alt text](file.jpg)"])(
    "does not treat Markdown image %s as bash bang",
    async (commandBody) => {
      const cfg = {
        commands: { bash: true, text: true },
        whatsapp: { allowFrom: ["*"] },
      } as OpenClawConfig;
      const params = buildParams(commandBody, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(true);
    },
  );

  it.each(["![image]", "![a]", "![ -f package.json ] && echo ok", "![ -d /tmp ]"])(
    "treats non-Markdown-image %s as bash bang",
    async (commandBody) => {
      resetBashChatCommandForTests();
      const cfg = {
        commands: { bash: true, text: true },
        whatsapp: { allowFrom: ["*"] },
      } as OpenClawConfig;
      const params = buildParams(commandBody, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
    },
  );

  it("routes !poll and !stop through the /bash handler", async () => {
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    for (const aliasCommand of ["!poll", "!stop"]) {
      resetBashChatCommandForTests();
      const params = buildParams(aliasCommand, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain("No active bash job");
    }
  });
});

function buildPolicyParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim(),
    commandAuthorized: true,
  });

  const params: HandleCommandsParams = {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "telegram",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
  return params;
}

describe("handleCommands /allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultChannelPluginRegistryForTests();
  });

  it("lists config + store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const cfg = {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["123", "@Alice"] } },
    } as OpenClawConfig;
    const params = buildPolicyParams("/allowlist list dm", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: telegram");
    expect(result.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("adds allowlist entries to config and pairing stores", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
    }));
    const cases = [
      {
        name: "default account",
        run: async () => {
          await withTempConfigPath(
            {
              channels: { telegram: { allowFrom: ["123"] } },
            },
            async (configPath) => {
              readConfigFileSnapshotMock.mockResolvedValueOnce({
                valid: true,
                parsed: {
                  channels: { telegram: { allowFrom: ["123"] } },
                },
              });
              addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
                changed: true,
                allowFrom: ["123", "789"],
              });

              const params = buildPolicyParams("/allowlist add dm 789", {
                commands: { text: true, config: true },
                channels: { telegram: { allowFrom: ["123"] } },
              } as OpenClawConfig);
              const result = await handleCommands(params);

              expect(result.shouldContinue).toBe(false);
              const written = await readJsonFile<OpenClawConfig>(configPath);
              expect(written.channels?.telegram?.allowFrom, "default account").toEqual([
                "123",
                "789",
              ]);
              expect(addChannelAllowFromStoreEntryMock, "default account").toHaveBeenCalledWith({
                channel: "telegram",
                entry: "789",
                accountId: "default",
              });
              expect(result.reply?.text, "default account").toContain("DM allowlist added");
            },
          );
        },
      },
      {
        name: "selected account scope",
        run: async () => {
          readConfigFileSnapshotMock.mockResolvedValueOnce({
            valid: true,
            parsed: {
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
            },
          });
          addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
            changed: true,
            allowFrom: ["123", "789"],
          });

          const params = buildPolicyParams(
            "/allowlist add dm --account work 789",
            {
              commands: { text: true, config: true },
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
            } as OpenClawConfig,
            {
              AccountId: "work",
            },
          );
          const result = await handleCommands(params);

          expect(result.shouldContinue, "selected account scope").toBe(false);
          expect(addChannelAllowFromStoreEntryMock, "selected account scope").toHaveBeenCalledWith({
            channel: "telegram",
            entry: "789",
            accountId: "work",
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("blocks config-targeted /allowlist edits when the target account disables writes", async () => {
    const previousWriteCount = writeConfigFileMock.mock.calls.length;
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          configWrites: true,
          accounts: {
            work: { configWrites: false, allowFrom: ["123"] },
          },
        },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const params = buildPolicyParams("/allowlist add dm --account work --config 789", cfg, {
      AccountId: "default",
      Provider: "telegram",
      Surface: "telegram",
    });
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(writeConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("removes default-account entries from scoped and legacy pairing stores", async () => {
    removeChannelAllowFromStoreEntryMock
      .mockResolvedValueOnce({
        changed: true,
        allowFrom: [],
      })
      .mockResolvedValueOnce({
        changed: true,
        allowFrom: [],
      });

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;
    const params = buildPolicyParams("/allowlist remove dm --store 789", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(1, {
      channel: "telegram",
      entry: "789",
      accountId: "default",
    });
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(2, {
      channel: "telegram",
      entry: "789",
    });
  });

  it("rejects blocked account ids and keeps Object.prototype clean", async () => {
    delete (Object.prototype as Record<string, unknown>).allowFrom;

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;
    const params = buildPolicyParams("/allowlist add dm --account __proto__ 789", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Invalid account id");
    expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("removes DM allowlist entries from canonical allowFrom and deletes legacy dm.allowFrom", async () => {
    const cases = [
      {
        provider: "slack",
        removeId: "U111",
        initialAllowFrom: ["U111", "U222"],
        expectedAllowFrom: ["U222"],
      },
      {
        provider: "discord",
        removeId: "111",
        initialAllowFrom: ["111", "222"],
        expectedAllowFrom: ["222"],
      },
    ] as const;
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
    }));

    for (const testCase of cases) {
      const initialConfig = {
        channels: {
          [testCase.provider]: {
            allowFrom: testCase.initialAllowFrom,
            dm: { allowFrom: testCase.initialAllowFrom },
            configWrites: true,
          },
        },
      };
      await withTempConfigPath(initialConfig, async (configPath) => {
        readConfigFileSnapshotMock.mockResolvedValueOnce({
          valid: true,
          parsed: structuredClone(initialConfig),
        });

        const cfg = {
          commands: { text: true, config: true },
          channels: {
            [testCase.provider]: {
              allowFrom: testCase.initialAllowFrom,
              dm: { allowFrom: testCase.initialAllowFrom },
              configWrites: true,
            },
          },
        } as OpenClawConfig;

        const params = buildPolicyParams(`/allowlist remove dm ${testCase.removeId}`, cfg, {
          Provider: testCase.provider,
          Surface: testCase.provider,
        });
        const result = await handleCommands(params);

        expect(result.shouldContinue).toBe(false);
        const written = await readJsonFile<OpenClawConfig>(configPath);
        const channelConfig = written.channels?.[testCase.provider];
        expect(channelConfig?.allowFrom).toEqual(testCase.expectedAllowFrom);
        expect(channelConfig?.dm?.allowFrom).toBeUndefined();
        expect(result.reply?.text).toContain(`channels.${testCase.provider}.allowFrom`);
      });
    }
  });
});

describe("/models command", () => {
  const cfg = {
    commands: { text: true },
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
  } as unknown as OpenClawConfig;

  it.each(["discord", "whatsapp"])("lists providers on %s (text)", async (surface) => {
    const params = buildPolicyParams("/models", cfg, { Provider: surface, Surface: surface });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Providers:");
    expect(result.reply?.text).toContain("anthropic");
    expect(result.reply?.text).toContain("Use: /models <provider>");
  });

  it("rejects unauthorized /models commands", async () => {
    const params = buildPolicyParams("/models", cfg, { Provider: "discord", Surface: "discord" });
    const result = await handleCommands({
      ...params,
      command: {
        ...params.command,
        isAuthorizedSender: false,
        senderId: "unauthorized",
      },
    });
    expect(result).toEqual({ shouldContinue: false });
  });

  it("lists providers on telegram (buttons)", async () => {
    const params = buildPolicyParams("/models", cfg, { Provider: "telegram", Surface: "telegram" });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("Select a provider:");
    const buttons = (result.reply?.channelData as { telegram?: { buttons?: unknown[][] } })
      ?.telegram?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons?.length).toBeGreaterThan(0);
  });

  it("handles provider model pagination, all mode, and unknown providers", async () => {
    const cases = [
      {
        name: "lists provider models with pagination hints",
        command: "/models anthropic",
        includes: [
          "Models (anthropic",
          "page 1/",
          "anthropic/claude-opus-4-5",
          "Switch: /model <provider/model>",
          "All: /models anthropic all",
        ],
        excludes: [],
      },
      {
        name: "ignores page argument when all flag is present",
        command: "/models anthropic 3 all",
        includes: ["Models (anthropic", "page 1/1", "anthropic/claude-opus-4-5"],
        excludes: ["Page out of range"],
      },
      {
        name: "errors on out-of-range pages",
        command: "/models anthropic 4",
        includes: ["Page out of range", "valid: 1-"],
        excludes: [],
      },
      {
        name: "handles unknown providers",
        command: "/models not-a-provider",
        includes: ["Unknown provider", "Available providers"],
        excludes: [],
      },
    ] as const;

    for (const testCase of cases) {
      // Use discord surface for deterministic text-based output assertions.
      const result = await handleCommands(
        buildPolicyParams(testCase.command, cfg, {
          Provider: "discord",
          Surface: "discord",
        }),
      );
      expect(result.shouldContinue, testCase.name).toBe(false);
      for (const expected of testCase.includes) {
        expect(result.reply?.text, `${testCase.name}: ${expected}`).toContain(expected);
      }
      for (const blocked of testCase.excludes ?? []) {
        expect(result.reply?.text, `${testCase.name}: !${blocked}`).not.toContain(blocked);
      }
    }
  });

  it("lists configured models outside the curated catalog", async () => {
    const customCfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: {
            primary: "localai/ultra-chat",
            fallbacks: ["anthropic/claude-opus-4-5"],
          },
          imageModel: "visionpro/studio-v1",
        },
      },
    } as unknown as OpenClawConfig;

    // Use discord surface for text-based output tests
    const providerList = await handleCommands(
      buildPolicyParams("/models", customCfg, { Surface: "discord" }),
    );
    expect(providerList.reply?.text).toContain("localai");
    expect(providerList.reply?.text).toContain("visionpro");

    const result = await handleCommands(
      buildPolicyParams("/models localai", customCfg, { Surface: "discord" }),
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Models (localai");
    expect(result.reply?.text).toContain("localai/ultra-chat");
    expect(result.reply?.text).not.toContain("Unknown provider");
  });

  it("threads the routed agent through /models replies", async () => {
    const scopedCfg = {
      commands: { text: true },
      agents: {
        defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
        list: [{ id: "support", model: "localai/ultra-chat" }],
      },
    } as unknown as OpenClawConfig;
    const params = buildPolicyParams("/models", scopedCfg, {
      Provider: "discord",
      Surface: "discord",
    });

    const result = await handleCommands({
      ...params,
      agentId: "support",
      sessionKey: "agent:support:main",
    });

    expect(result.reply?.text).toContain("localai");
  });
});

describe("handleCommands plugin commands", () => {
  it("dispatches registered plugin commands", async () => {
    clearPluginCommands();
    const result = registerPluginCommand("test-plugin", {
      name: "card",
      description: "Test card",
      handler: async () => ({ text: "from plugin" }),
    });
    expect(result.ok).toBe(true);

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/card", cfg);
    const commandResult = await handleCommands(params);

    expect(commandResult.shouldContinue).toBe(false);
    expect(commandResult.reply?.text).toBe("from plugin");
    clearPluginCommands();
  });
});

describe("handleCommands identity", () => {
  it("returns sender details for /whoami", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/whoami", cfg, {
      SenderId: "12345",
      SenderUsername: "TestUser",
      ChatType: "direct",
    });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: whatsapp");
    expect(result.reply?.text).toContain("User id: 12345");
    expect(result.reply?.text).toContain("Username: @TestUser");
    expect(result.reply?.text).toContain("AllowFrom: 12345");
  });
});

describe("handleCommands hooks", () => {
  it("triggers hooks for /new commands", async () => {
    const cases = [
      {
        name: "text command with arguments",
        params: buildParams("/new take notes", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        expectedCall: expect.objectContaining({ type: "command", action: "new" }),
      },
      {
        name: "native command routed to target session",
        params: (() => {
          const params = buildParams(
            "/new",
            {
              commands: { text: true },
              channels: { telegram: { allowFrom: ["*"] } },
            } as OpenClawConfig,
            {
              Provider: "telegram",
              Surface: "telegram",
              CommandSource: "native",
              CommandTargetSessionKey: "agent:main:telegram:direct:123",
              SessionKey: "telegram:slash:123",
              SenderId: "123",
              From: "telegram:123",
              To: "slash:123",
              CommandAuthorized: true,
            },
          );
          params.sessionKey = "agent:main:telegram:direct:123";
          return params;
        })(),
        expectedCall: expect.objectContaining({
          type: "command",
          action: "new",
          sessionKey: "agent:main:telegram:direct:123",
          context: expect.objectContaining({
            workspaceDir: testWorkspaceDir,
          }),
        }),
      },
    ] as const;
    for (const testCase of cases) {
      const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();
      await handleCommands(testCase.params);
      expect(spy, testCase.name).toHaveBeenCalledWith(testCase.expectedCall);
      spy.mockRestore();
    }
  });
});

describe("handleCommands context", () => {
  it("returns expected details for /context commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const cases = [
      {
        commandBody: "/context",
        expectedText: ["/context list", "Inline shortcut"],
      },
      {
        commandBody: "/context list",
        expectedText: ["Injected workspace files:", "AGENTS.md"],
      },
      {
        commandBody: "/context detail",
        expectedText: ["Context breakdown (detailed)", "Top tools (schema size):"],
      },
    ] as const;
    for (const testCase of cases) {
      const params = buildParams(testCase.commandBody, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      for (const expectedText of testCase.expectedText) {
        expect(result.reply?.text).toContain(expectedText);
      }
    }
  });
});

describe("handleCommands subagents", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear().mockImplementation(async () => ({}));
  });

  it("lists subagents when none exist", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("active subagents:\n-----\n");
    expect(result.reply?.text).toContain("recent subagents (last 30m):");
    expect(result.reply?.text).toContain("\n\nrecent subagents (last 30m):");
    expect(result.reply?.text).toContain("recent subagents (last 30m):\n-----\n");
  });

  it("truncates long subagent task text in /subagents list", async () => {
    addSubagentRunForTests({
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(result.reply?.text).toContain("...");
    expect(result.reply?.text).not.toContain("after a short hard cutoff.");
  });

  it("lists subagents for the command target session for native /subagents", async () => {
    addSubagentRunForTests({
      runId: "run-target",
      childSessionKey: "agent:main:subagent:target",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "target run",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    addSubagentRunForTests({
      runId: "run-slash",
      childSessionKey: "agent:main:subagent:slash",
      requesterSessionKey: "agent:main:slack:slash:u1",
      requesterDisplayKey: "agent:main:slack:slash:u1",
      task: "slash run",
      cleanup: "keep",
      createdAt: 2000,
      startedAt: 2000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg, {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
    });
    params.sessionKey = "agent:main:slack:slash:u1";
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("target run");
    expect(result.reply?.text).not.toContain("slash run");
  });

  it("keeps ended orchestrators in active list while descendants are pending", async () => {
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active (waiting on 1 child)");
    expect(result.reply?.text).not.toContain(
      "recent subagents (last 30m):\n-----\n1. orchestrate child workers",
    );
  });

  it("formats subagent usage with io and prompt/cache breakdown", async () => {
    addSubagentRunForTests({
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      };
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(result.reply?.text).toContain("prompt/cache 197k");
    expect(result.reply?.text).not.toContain("1k io");
  });

  it.each([
    {
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      verboseLevel: "on" as const,
      expectedText: [] as string[],
      unexpectedText: ["Subagents:"],
    },
    {
      name: "includes subagent count in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
      },
      verboseLevel: "off" as const,
      expectedText: ["🤖 Subagents: 1 active"],
      unexpectedText: [] as string[],
    },
    {
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
        addSubagentRunForTests({
          runId: "run-2",
          childSessionKey: "agent:main:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 900,
          startedAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 1 active", "· 1 done"],
      unexpectedText: [] as string[],
    },
  ])("$name", async ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/status", cfg);
    if (verboseLevel === "on") {
      params.resolvedVerboseLevel = "on";
    }
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    for (const expected of expectedText) {
      expect(result.reply?.text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(result.reply?.text).not.toContain(blocked);
    }
  });

  it("returns help/usage for invalid or incomplete subagents commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const cases = [
      { commandBody: "/subagents foo", expectedText: "/subagents" },
      { commandBody: "/subagents info", expectedText: "/subagents info" },
    ] as const;
    for (const testCase of cases) {
      const params = buildParams(testCase.commandBody, cfg);
      const result = await handleCommands(params);
      expect(result.shouldContinue).toBe(false);
      expect(result.reply?.text).toContain(testCase.expectedText);
    }
  });

  it("returns info for a subagent", async () => {
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/subagents info 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Run: run-1");
    expect(result.reply?.text).toContain("Status: done");
  });

  it("kills subagents via /kill alias without a confirmation reply", async () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("resolves numeric aliases in active-first display order", async () => {
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recent task",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
      endedAt: now - 10_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("sends follow-up messages to finished subagents", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "agent") {
        return { runId: "run-followup-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "done" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents send 1 continue with follow-up details", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("✅ Sent to");

    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        timeout: 0,
      },
    });

    const waitCall = callGatewayMock.mock.calls.find(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId ===
          "run-followup-1",
    );
    expect(waitCall).toBeDefined();
  });

  it("blocks leaf subagents from sending to explicitly-owned child sessions", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const childKey = `${leafKey}:subagent:child`;
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-send-scope.json");
    await updateSessionStore(storePath, (store) => {
      store[leafKey] = {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        subagentRole: "leaf",
        subagentControlScope: "none",
      };
      store[childKey] = {
        sessionId: "child-session",
        updatedAt: Date.now(),
        spawnedBy: leafKey,
        subagentRole: "leaf",
        subagentControlScope: "none",
      };
    });
    addSubagentRunForTests({
      runId: "run-child-send",
      childSessionKey: childKey,
      requesterSessionKey: leafKey,
      requesterDisplayKey: leafKey,
      task: "child follow-up target",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/subagents send 1 continue with follow-up details", cfg);
    params.sessionKey = leafKey;

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Leaf subagents cannot control other sessions.");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("steers subagents via /steer alias", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-steer-1" };
      }
      return {};
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-steer.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:abc"] = {
        sessionId: "child-session-steer",
        updatedAt: Date.now(),
      };
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("steered");
    const steerWaitIndex = callGatewayMock.mock.calls.findIndex(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId === "run-1",
    );
    expect(steerWaitIndex).toBeGreaterThanOrEqual(0);
    const steerRunIndex = callGatewayMock.mock.calls.findIndex(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(steerRunIndex).toBeGreaterThan(steerWaitIndex);
    expect(callGatewayMock.mock.calls[steerWaitIndex]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "run-1", timeoutMs: 5_000 },
      timeoutMs: 7_000,
    });
    expect(callGatewayMock.mock.calls[steerRunIndex]?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        sessionId: "child-session-steer",
        timeout: 0,
      },
    });
    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-steer-1");
    expect(trackedRuns[0].endedAt).toBeUndefined();
  });

  it("restores announce behavior when /steer replacement dispatch fails", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "agent") {
        throw new Error("dispatch failed");
      }
      return {};
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("send failed: dispatch failed");

    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-1");
    expect(trackedRuns[0].suppressAnnounceReason).toBeUndefined();
  });
});

describe("handleCommands /tts", () => {
  it("returns status for bare /tts on text command surfaces", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: { tts: { prefsPath: path.join(testWorkspaceDir, "tts.json") } },
    } as OpenClawConfig;
    const params = buildParams("/tts", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("TTS status");
  });
});

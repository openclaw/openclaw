// Tests command gating rules for ownership, channel, and active session state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import type { MsgContext } from "../templating.js";
import { handleBashChatCommand } from "./bash-command.js";
import { requireGatewayClientScope } from "./command-gates.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import type { ConfigSnapshotMock } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({ valid: true, parsed: {} })),
);
const validateConfigObjectWithPluginsMock = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    config: {},
    issues: [],
  })),
);
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const getConfigOverridesMock = vi.hoisted(() => vi.fn(() => ({})));
const resolveConfigWriteDeniedTextMock = vi.hoisted(() =>
  vi.fn<(...args: never[]) => string | null>(() => null),
);
const isInternalMessageChannelMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getFinishedSession: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: vi.fn(),
}));

// mock-isolation: Exercise command authorization without sandbox backends or session storage.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatusAsync: vi.fn(async () => ({ sandboxed: false })),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    clampInt: vi.fn((value: number) => value),
  };
});

vi.mock("./mentions.js", () => ({
  stripMentions: vi.fn((value: string) => value),
  stripStructuralPrefixes: vi.fn((value: string) => value),
}));

vi.mock("../../channels/plugins/config-writes.js", () => ({
  resolveConfigWriteTargetFromPath: vi.fn(() => "config"),
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeAnyChannelId: vi.fn((value?: string) => value),
  normalizeChannelId: vi.fn((value?: string) => value),
}));

// mock-isolation: exercise config write authorization against fixture state, not operator config.
vi.mock("../../config/config.js", () => {
  const transformConfigFileWithRetry = async (params: {
    afterWrite?: unknown;
    transform: (
      currentConfig: OpenClawConfig,
      context: { snapshot: ConfigSnapshotMock; previousHash: string | null; attempt: number },
    ) =>
      | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>
      | {
          nextConfig: OpenClawConfig;
          result?: unknown;
        };
  }) => {
    const snapshot = (await readConfigFileSnapshotMock()) as ConfigSnapshotMock;
    const previousHash = snapshot.hash ?? null;
    const currentConfig = structuredClone(
      snapshot.sourceConfig ?? snapshot.resolved ?? snapshot.runtimeConfig ?? snapshot.parsed ?? {},
    );
    const transformed = await params.transform(currentConfig, {
      snapshot,
      previousHash,
      attempt: 0,
    });
    const afterWrite = params.afterWrite ?? { mode: "auto" };
    await replaceConfigFileMock({ nextConfig: transformed.nextConfig, afterWrite });
  };
  return {
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    replaceConfigFile: replaceConfigFileMock,
    transformConfigFileWithRetry,
    mutateConfigFileWithRetry: (params: {
      afterWrite?: unknown;
      mutate: (draft: OpenClawConfig) => unknown;
    }) =>
      transformConfigFileWithRetry({
        afterWrite: params.afterWrite,
        transform: async (currentConfig) => {
          const nextConfig = structuredClone(currentConfig);
          await params.mutate(nextConfig);
          return { nextConfig };
        },
      }),
  };
});

vi.mock("../../config/runtime-overrides.js", () => ({
  getConfigOverrides: getConfigOverridesMock,
  resetConfigOverrides: vi.fn(),
  setConfigOverride: vi.fn((pathRaw: string) => ({ ok: true, value: pathRaw.split(".") })),
  unsetConfigOverride: vi.fn(() => ({ ok: true, value: true })),
}));

// mock-isolation: Use static hints without runtime config reads or plugin discovery in authorization tests.
vi.mock("../../config/runtime-schema.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/schema.js")>("../../config/schema.js");
  return {
    loadGatewayConfigRedactionHints: () => actual.buildConfigSchemaCore().uiHints,
  };
});

vi.mock("../../utils/message-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-channel.js")>()),
  isInternalMessageChannel: isInternalMessageChannelMock,
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => undefined),
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: resolveConfigWriteDeniedTextMock,
}));

function buildParams(commandBody: string, cfg: OpenClawConfig): HandleCommandsParams {
  return commandFixture(
    commandBody.trim(),
    {
      cfg,
      ctx: {
        Body: commandBody,
        CommandBody: commandBody,
        CommandSource: "text",
        CommandAuthorized: true,
        Provider: "whatsapp",
        Surface: "whatsapp",
        SessionKey: "agent:main:main",
      },
      sessionKey: "agent:main:main",
      agentId: "main",
      workspaceDir: "/tmp",
      provider: "whatsapp",
      model: "test-model",
      sessionEntry: undefined,
    },
    {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      senderIsOwner: false,
      senderId: "user-1",
      from: "user-1",
      to: "bot-1",
    },
  );
}

function ownerParams(commandBody: string): HandleCommandsParams {
  const params = buildParams(commandBody, {
    commands: { text: true, [commandBody.startsWith("/debug") ? "debug" : "config"]: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  });
  params.command.senderIsOwner = true;
  return params;
}

function webParams(commandBody: string, scopes: string[]): HandleCommandsParams {
  const params = buildParams(commandBody, { commands: { config: true, text: true } });
  Object.assign(params.ctx, {
    Provider: "webchat",
    Surface: "webchat",
    GatewayClientScopes: scopes,
  });
  Object.assign(params.command, {
    channel: "webchat",
    channelId: "webchat",
    surface: "webchat",
    senderIsOwner: true,
  });
  return params;
}

describe("command gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ valid: true, parsed: {} });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      ok: true,
      config: {},
      issues: [],
    });
    getConfigOverridesMock.mockReturnValue({});
  });

  it.each([
    [false, true, "bash is disabled"],
    [true, false, "elevated is not available"],
  ] as const)("blocks bash (enabled=%s, elevated=%s)", async (bash, allowed, expected) => {
    const result = await handleBashChatCommand({
      ctx: {
        Body: "/bash echo hi",
        CommandBody: "/bash echo hi",
        SessionKey: "agent:main:main",
      } as MsgContext,
      cfg: { commands: { bash } },
      sessionKey: "agent:main:main",
      isGroup: false,
      elevated: {
        enabled: true,
        allowed,
        failures: allowed ? [] : [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
      },
    });
    expect(result.text).toContain(expected);
  });

  it("blocks a stale owner snapshot before reading or writing config", async () => {
    const params = buildParams("/config show", { commands: { config: true, text: true } });
    params.command.senderIsOwner = true;
    params.command.assertOwnerCurrent = () => {
      throw new Error("requester revoked during dispatch");
    };
    const result = await handleConfigCommand(params, true);
    expect(result?.reply?.text).toContain("owner authority changed");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["config", handleConfigCommand],
    ["debug", handleDebugCommand],
  ] as const)("blocks disabled %s", async (name, handler) => {
    const params = buildParams(`/${name} show`, {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    params.command.senderIsOwner = true;
    const result = await handler(params, true);
    expect(result?.reply?.text).toContain(`/${name} is disabled`);
  });

  it.each([
    ["config", handleConfigCommand],
    ["debug", handleDebugCommand],
  ] as const)("blocks authorized non-owners from /%s show", async (name, handler) => {
    const params = ownerParams(`/${name} show`);
    params.command.senderIsOwner = false;
    expect(await handler(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
  });

  it("keeps /config show and /debug show available for owners", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const configParams = ownerParams("/config show messages.ackReaction");
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult?.reply?.text).toContain("⚙️ Config");
    expect(configResult?.reply?.text).toContain('":)"');

    const debugParams = ownerParams("/debug show");
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult?.reply?.text).toContain("Debug overrides");
  });

  it("redacts secret-shaped fields from full /config show replies", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        gateway: {
          auth: {
            mode: "token",
            token: "OPENCLAW_CONFIG_SHOW_CANARY_TOKEN_65623",
            password: "OPENCLAW_CONFIG_SHOW_CANARY_PASSWORD_65623",
          },
          bind: "127.0.0.1",
          port: 3210,
        },
        models: {
          providers: {
            openai: {
              apiKey: "OPENCLAW_CONFIG_SHOW_CANARY_API_KEY_65623",
              baseUrl: "https://api.example.test",
              models: [{ id: "gpt-test", name: "gpt-test" }],
            },
          },
        },
        browser: {
          cdpUrl:
            "wss://chrome.example.test/devtools?token=OPENCLAW_CONFIG_SHOW_CANARY_CDP_TOKEN_65623&apiKey=OPENCLAW_CONFIG_SHOW_CANARY_CDP_API_KEY_65623",
          profiles: {
            local: {
              cdpUrl: "ws://localhost:9222",
            },
            remote: {
              cdpUrl:
                "wss://chrome.remote.example.test/devtools?apiKey=OPENCLAW_CONFIG_SHOW_CANARY_CDP_PROFILE_API_KEY_65623",
            },
          },
        },
        talk: {
          providers: {
            openai: {
              apiKey: "OPENCLAW_CONFIG_SHOW_CANARY_API_KEY_65623",
              baseUrl: "https://api.example.test",
              model: "gpt-test",
            },
          },
        },
        channels: {
          telegram: {
            botToken: "1234567890TELEGRAM_BOT_TOKEN",
            enabled: true,
          },
          slack: {
            token: {
              source: "env",
              provider: "default",
              id: "SLACK_BOT_TOKEN",
            },
          },
        },
      },
    });
    const params = ownerParams("/config show");

    const result = await handleConfigCommand(params, true);
    const output = result?.reply?.text ?? "";

    expect(output).toContain("gateway");
    expect(output).toContain("token");
    expect(output).toContain("password");
    expect(output).toContain("apiKey");
    expect(output).toContain("browser");
    expect(output).toContain("cdpUrl");
    expect(output).toContain(REDACTED_SENTINEL);
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_TOKEN_65623");
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_PASSWORD_65623");
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_API_KEY_65623");
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_CDP_TOKEN_65623");
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_CDP_API_KEY_65623");
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_CDP_PROFILE_API_KEY_65623");
    expect(output).toContain('"mode": "token"');
    expect(output).toContain('"bind": "127.0.0.1"');
    expect(output).toContain('"port": 3210');
    expect(output).toContain('"enabled": true');
    expect(output).toContain('"model": "gpt-test"');
    expect(output).toContain('"baseUrl": "https://api.example.test"');
    expect(output).toContain('"cdpUrl": "ws://localhost:9222"');
  });

  it("redacts secret-shaped values from path-specific /config show replies", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        gateway: {
          auth: {
            mode: "token",
            token: "OPENCLAW_CONFIG_SHOW_CANARY_TOKEN_65623",
          },
        },
      },
    });
    const params = ownerParams("/config show gateway.auth.token");

    const result = await handleConfigCommand(params, true);
    const output = result?.reply?.text ?? "";

    expect(output).toContain("Config gateway.auth.token");
    expect(output).toContain(REDACTED_SENTINEL);
    expect(output).not.toContain("OPENCLAW_CONFIG_SHOW_CANARY_TOKEN_65623");
  });

  it("redacts secret-shaped fields from /debug show replies", async () => {
    getConfigOverridesMock.mockReturnValueOnce({
      gateway: {
        auth: {
          token: "OPENCLAW_DEBUG_SHOW_CANARY_TOKEN_65623",
        },
      },
      channels: {
        telegram: {
          botToken: "OPENCLAW_DEBUG_SHOW_CANARY_BOT_TOKEN_65623",
        },
      },
      messages: {
        ackReaction: ":)",
      },
    });
    const params = ownerParams("/debug show");

    const result = await handleDebugCommand(params, true);
    const output = result?.reply?.text ?? "";

    expect(output).toContain("Debug overrides (memory-only)");
    expect(output).toContain(REDACTED_SENTINEL);
    expect(output).toContain("ackReaction");
    expect(output).not.toContain("OPENCLAW_DEBUG_SHOW_CANARY_TOKEN_65623");
    expect(output).not.toContain("OPENCLAW_DEBUG_SHOW_CANARY_BOT_TOKEN_65623");
  });

  it.each([
    ["config", handleConfigCommand, "Config updated"],
    ["debug", handleDebugCommand, "Debug override set"],
  ] as const)("redacts /%s set acknowledgements", async (name, handler, label) => {
    if (name === "config") {
      readConfigFileSnapshotMock.mockResolvedValue({
        valid: true,
        parsed: { gateway: { auth: { mode: "token" } } },
      });
    }
    const secret = `OPENCLAW_${name.toUpperCase()}_SET_CANARY_TOKEN_65623`;
    const result = await handler(ownerParams(`/${name} set gateway.auth.token="${secret}"`), true);
    const output = result?.reply?.text ?? "";
    expect(output).toContain(`${label}: gateway.auth.token=`);
    expect(output).toContain(REDACTED_SENTINEL);
    expect(output).not.toContain(secret);
  });

  it("blocks disallowed /config set writes", async () => {
    resolveConfigWriteDeniedTextMock.mockReturnValueOnce("Config writes are disabled");
    const params = buildParams('/config set messages.ackReaction=":)"', {
      commands: { config: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"], configWrites: false } },
    });
    params.command.senderIsOwner = true;

    const result = await handleConfigCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Config writes are disabled");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("enforces gateway client permissions when the command channel is external", () => {
    const result = requireGatewayClientScope(
      {
        ctx: {
          Provider: "internal",
          OriginatingChannel: "telegram",
          GatewayClientScopes: ["operator.write"],
        },
        command: {
          channel: "telegram",
        },
      } as unknown as HandleCommandsParams,
      {
        label: "/config write",
        allowedScopes: ["operator.admin"],
        missingText: "/config set|unset requires operator.admin for gateway clients.",
      },
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
    expect(isInternalMessageChannelMock).not.toHaveBeenCalled();
  });

  it("enforces gateway client permissions when the scope list is empty", () => {
    const result = requireGatewayClientScope(
      {
        ctx: {
          Provider: "internal",
          OriginatingChannel: "telegram",
          GatewayClientScopes: [],
        },
        command: {
          channel: "telegram",
        },
      } as unknown as HandleCommandsParams,
      {
        label: "/config write",
        allowedScopes: ["operator.admin"],
        missingText: "/config set|unset requires operator.admin for gateway clients.",
      },
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
    expect(isInternalMessageChannelMock).not.toHaveBeenCalled();
  });

  it("enforces gateway client permissions for /config commands", async () => {
    const blockedParams = webParams('/config set messages.ackReaction=":)"', ["operator.write"]);
    const blockedResult = await handleConfigCommand(blockedParams, true);
    expect(blockedResult?.shouldContinue).toBe(false);
    expect(blockedResult?.reply?.text).toContain("requires operator.admin");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const showParams = webParams("/config show messages.ackReaction", ["operator.write"]);
    const showResult = await handleConfigCommand(showParams, true);
    expect(showResult?.shouldContinue).toBe(false);
    expect(showResult?.reply?.text).toContain("Config messages.ackReaction");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const setParams = webParams('/config set messages.ackReaction=":D"', [
      "operator.write",
      "operator.admin",
    ]);
    const setResult = await handleConfigCommand(setParams, true);
    expect(setResult?.shouldContinue).toBe(false);
    expect(setResult?.reply?.text).toContain("Config updated");
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { ackReaction: ":D" } },
      afterWrite: { mode: "auto" },
    });
  });

  it("does not write config when /config unset misses", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      parsed: { messages: {} },
    });
    const params = buildParams("/config unset messages.missing", {
      commands: { config: true, text: true },
    } as OpenClawConfig);
    params.ctx.GatewayClientScopes = ["operator.admin"];
    params.command.senderIsOwner = true;

    const result = await handleConfigCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No config value found");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });
});

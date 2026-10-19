import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { CliDeps } from "../cli/deps.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { messageCommand } from "./message.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

let resetPluginRuntimeStateForTest: typeof import("../plugins/runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;

type RunMessageActionParams = Parameters<
  typeof import("../infra/outbound/message-action-runner.js").runMessageAction
>[0];

function readOnlyMessageActionCall(): RunMessageActionParams {
  expect(runMessageActionMock).toHaveBeenCalledOnce();
  return expectDefined(runMessageActionMock.mock.calls[0]?.[0], "Expected message action call");
}

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ config, changes: [] })));
// mock-isolation: Message dispatch receives testConfig without reading host channel credentials.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testConfig,
  loadConfig: () => testConfig,
  captureRuntimeConfigAsyncReader: () => async () => testConfig,
}));

// mock-isolation: Auto-enable only the synthetic config selected by each message scenario.
vi.mock("../config/plugin-auto-enable.js", () => ({ applyPluginAutoEnable }));

const resolveCommandConfigWithSecrets = vi.hoisted(() =>
  vi.fn(async (opts: { autoEnable?: boolean; config: unknown; env?: NodeJS.ProcessEnv }) => ({
    resolvedConfig: opts.config,
    effectiveConfig:
      opts.autoEnable === true
        ? applyPluginAutoEnable({ config: opts.config, env: opts.env ?? process.env }).config
        : opts.config,
    diagnostics: [] as string[],
  })),
);
// mock-isolation: Resolve fixture SecretRefs without reading operator credentials.
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets,
}));

const getScopedChannelsCommandSecretTargets = vi.hoisted(() =>
  vi.fn(() => ({ targetIds: new Set(["channels.telegram.token"]) })),
);

vi.mock("../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets,
}));

const runMessageActionMock = vi.hoisted(() =>
  vi.fn(async ({ action, params }: RunMessageActionParams): Promise<MessageActionResult> => {
    const base = {
      channel: typeof params.channel === "string" ? params.channel : "telegram",
      to: typeof params.target === "string" ? params.target : "123456",
      handledBy: "plugin" as const,
      payload: { ok: true },
      dryRun: false,
    };
    return action === "poll"
      ? { ...base, kind: "poll", action: "poll" }
      : { ...base, kind: "send", action: "send" };
  }),
);

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: runMessageActionMock,
}));

beforeAll(async () => {
  ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../plugins/runtime.js"));
  ({ createTestRegistry } = await import("../test-utils/channel-plugins.js"));
});

const runtime = createThrowingTestRuntime();

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  testConfig = {};
  vi.clearAllMocks();
  applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
});

function createAccountPlugin(
  id: string,
  accountIds: string[],
  config: Partial<ChannelPlugin["config"]> = {},
  capabilities: ChannelPlugin["capabilities"] = { chatTypes: ["direct", "group"], media: true },
): ChannelPlugin {
  return {
    id,
    meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "test" },
    capabilities,
    config: {
      listAccountIds: () => accountIds,
      inspectAccount: () => ({ enabled: true }),
      resolveAccount: () => {
        throw new Error("raw account credentials must not resolve during planning");
      },
      ...config,
    },
  };
}

const makeDeps = (): CliDeps => ({
  whatsapp: vi.fn(),
  telegram: vi.fn(),
  discord: vi.fn(),
  slack: vi.fn(),
  signal: vi.fn(),
  imessage: vi.fn(),
});

function createTelegramSecretRawConfig() {
  return {
    channels: {
      telegram: {
        token: { $secret: "vault://telegram/token" }, // pragma: allowlist secret
      },
    },
  };
}

function createTelegramResolvedTokenConfig(token: string) {
  return {
    channels: {
      telegram: {
        token,
      },
    },
  };
}

function mockResolvedCommandConfig(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  testConfig = params.rawConfig;
  resolveCommandConfigWithSecrets.mockResolvedValueOnce({
    resolvedConfig: params.resolvedConfig,
    effectiveConfig: params.resolvedConfig,
    diagnostics: params.diagnostics ?? ["resolved channels.telegram.token"],
  });
}

async function runMessageCommand(opts: Record<string, unknown> = {}) {
  await messageCommand(
    {
      action: "send",
      channel: "telegram",
      target: "123456",
      message: "hi",
      json: true,
      ...opts,
    },
    makeDeps(),
    runtime,
  );
}
function jsonOutput(): unknown {
  return JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
}
const runBroadcast = (accountId: string, targets: string[]) =>
  runMessageCommand({ action: "broadcast", channel: "all", target: undefined, targets, accountId });
function expectBroadcastPlan(
  accountId: string,
  candidateChannels: string[],
  secretChannels: string[],
) {
  expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
    config: testConfig,
    channel: undefined,
    channels: secretChannels,
    accountId,
  });
  expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
    accountId,
    candidateChannels,
    secretChannels,
  });
}

describe("messageCommand", () => {
  it("includes aggregate broadcast failure and every target row in JSON output", async () => {
    const results: Extract<MessageActionResult, { kind: "broadcast" }>["payload"]["results"] = [
      { channel: "telegram", to: "123", ok: true },
      { channel: "telegram", to: "456", ok: false, error: "provider rejected the message" },
    ];
    runMessageActionMock.mockResolvedValueOnce({
      kind: "broadcast",
      channel: "telegram",
      action: "broadcast",
      handledBy: "core",
      payload: { results },
      dryRun: false,
    });

    await runMessageCommand({
      action: "broadcast",
      target: undefined,
      targets: ["123", "456"],
    });

    expect(jsonOutput()).toMatchObject({ ok: false });
    expect(jsonOutput()).toHaveProperty("payload.results", results);
  });

  it.each([
    [{ accountId: "!!!" }, "Invalid account ID", true],
    [{ action: "nope" }, "Unknown message action", false],
  ] as const)(
    "rejects invalid command %j before dispatch",
    async (options, error, beforeSecrets) => {
      await expect(runMessageCommand(options)).rejects.toThrow(error);
      if (beforeSecrets) {
        expect(resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
      }
      expect(runMessageActionMock).not.toHaveBeenCalled();
    },
  );

  it("scopes unqualified broadcast secrets to channels accepting the explicit account", async () => {
    const slackPlugin = createAccountPlugin("slack", ["shared"]);
    slackPlugin.config.isEnabled = vi.fn(() => {
      throw new Error("runtime enablement must not receive inspection metadata");
    });
    const telegramPlugin = createAccountPlugin("telegram", ["default"]);
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", plugin: slackPlugin },
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
      ]),
    );
    testConfig = { channels: { slack: {}, telegram: {} } };

    await runBroadcast("shared", ["slack:channel:ops", "telegram:123"]);

    expectBroadcastPlan("shared", ["slack", "telegram"], ["slack"]);
    expect(slackPlugin.config.isEnabled).not.toHaveBeenCalled();
  });

  it("excludes unknown legacy-plugin accounts before account or secret resolution", async () => {
    const resolveAccount = vi.fn(() => ({ accountId: "default", enabled: true }));
    const buzzPlugin = createAccountPlugin(
      "buzz",
      ["default"],
      { inspectAccount: undefined, resolveAccount },
      { chatTypes: ["group"] },
    );
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "buzz", source: "test", plugin: buzzPlugin }]),
    );
    testConfig = { channels: { buzz: {} } };

    await runBroadcast("ops", ["00000000-0000-4000-8000-000000000001"]);

    expect(resolveAccount).not.toHaveBeenCalled();
    expectBroadcastPlan("ops", ["buzz"], []);
  });

  it("threads resolved SecretRef config into message actions", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    mockResolvedCommandConfig({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    await runMessageCommand();

    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.cfg).toBe(resolvedConfig);
    expect(actionCall.action).toBe("send");
    expect(actionCall.params.channel).toBe("telegram");
    expect(actionCall.params.target).toBe("123456");
    expect(actionCall.params.message).toBe("hi");
    expect(actionCall.agentId).toBe("main");
    expect(actionCall.senderIsOwner).toBe(true);
    expect(actionCall.conversationReadOrigin).toBe("direct-operator");
    expect(actionCall.gateway?.clientName).toBe("cli");
    expect(actionCall.gateway?.mode).toBe("cli");
    expect(actionCall.cfg).not.toBe(rawConfig);
    const configResolutionCall = resolveCommandConfigWithSecrets.mock.calls[0]?.[0] as {
      commandName?: string;
      config?: unknown;
      targetIds?: Set<string>;
    };
    expect(configResolutionCall.config).toBe(rawConfig);
    expect(configResolutionCall.commandName).toBe("message");
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: rawConfig,
      channel: "telegram",
      accountId: undefined,
    });
    expect(configResolutionCall.targetIds).toBeInstanceOf(Set);
    expect(
      [...(configResolutionCall.targetIds ?? [])].filter(
        (id) => !id.startsWith("channels.telegram."),
      ),
    ).toStrictEqual([]);
  });

  it("keeps the retained legacy owner after config load strips the default marker", async () => {
    const migrated = createCanonicalAgentConfigFixture({
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: { telegram: {} },
    }).config as Record<string, unknown>;
    testConfig = migrated;
    const effectiveConfig = structuredClone(migrated);
    applyPluginAutoEnable.mockReturnValueOnce({ config: effectiveConfig, changes: [] });

    await runMessageCommand();

    expect(
      (migrated.agents as { entries?: { ops?: { default?: boolean } } }).entries?.ops?.default,
    ).toBeUndefined();
    expect(readOnlyMessageActionCall().cfg).toBe(effectiveConfig);
    expect(readOnlyMessageActionCall().agentId).toBe("ops");
  });

  it.each([false])(
    "guides an ownerless explicit fleet to a system owner (dryRun=%s)",
    async (dryRun) => {
      const ownerlessConfig = {
        agents: {
          ownership: "explicit" as const,
          entries: { ops: {}, research: {} },
        },
      };
      mockResolvedCommandConfig({
        rawConfig: {},
        resolvedConfig: ownerlessConfig,
        diagnostics: [],
      });

      const failedRun = runMessageCommand({ dryRun });
      await expect(failedRun).rejects.toMatchObject({
        code: "AGENT_SELECTION_REQUIRED",
        hint: expect.stringContaining("agents.defaults.systemAgent.agentId"),
      });
      await expect(failedRun).rejects.not.toThrow("--agent");
      expect(runMessageActionMock).not.toHaveBeenCalled();

      const effectiveConfig = {
        agents: {
          ...ownerlessConfig.agents,
          defaults: { systemAgent: { agentId: "ops" } },
        },
      };
      mockResolvedCommandConfig({
        rawConfig: {},
        resolvedConfig: effectiveConfig,
        diagnostics: [],
      });

      await runMessageCommand({ dryRun });

      expect(readOnlyMessageActionCall().cfg).toBe(effectiveConfig);
      expect(readOnlyMessageActionCall().agentId).toBe("ops");
    },
  );

  it("normalizes poll actions and sender ownership before dispatch", async () => {
    await runMessageCommand({
      action: "poll",
      channel: "telegram",
      target: "123456789",
      pollQuestion: "Ship it?",
      pollOption: ["Yes", "No"],
      senderIsOwner: false,
    });

    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.action).toBe("poll");
    expect(actionCall.senderIsOwner).toBe(false);
    expect(actionCall.params.channel).toBe("telegram");
    expect(actionCall.params.target).toBe("123456789");
    expect(actionCall.params.pollQuestion).toBe("Ship it?");
  });

  it("reports partial delivery failure truthfully in JSON output", async () => {
    const sendResult = {
      channel: "discord",
      to: "channel:general",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: "partial_failed" as const,
      error: "second attachment rejected",
      result: { channel: "discord", messageId: "first-part-1" },
      sentBeforeError: true as const,
    };
    runMessageActionMock.mockResolvedValueOnce({
      kind: "send",
      channel: "discord",
      action: "send",
      to: "channel:general",
      handledBy: "core",
      payload: sendResult,
      sendResult,
      dryRun: false,
    });
    await runMessageCommand({ channel: "discord", target: "channel:general" });
    const json = jsonOutput();
    expect(json).toMatchObject({
      ok: false,
      deliveryStatus: "partial_failed",
      error: { type: "cli_error", message: "second attachment rejected" },
      messageId: "first-part-1",
      sentBeforeError: true,
    });
    expect(json).toHaveProperty("payload", sendResult);
  });

  it("reports rejected polls truthfully in JSON output", async () => {
    const payload = { ok: false, error: "Poll rejected" };
    runMessageActionMock.mockResolvedValueOnce({
      kind: "poll",
      channel: "telegram",
      action: "poll",
      to: "123456",
      handledBy: "plugin",
      payload,
      dryRun: false,
    });

    await runMessageCommand({ action: "poll" });

    const json = jsonOutput();
    expect(json).toMatchObject({
      ok: false,
      error: { type: "cli_error", message: "Poll rejected" },
    });
    expect(json).toHaveProperty("payload", payload);
    expect(json).not.toHaveProperty("deliveryStatus");
  });
});

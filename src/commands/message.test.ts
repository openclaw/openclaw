// Message command tests cover CLI message sending, environment handling, and runtime dependency wiring.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { CliDeps } from "../cli/deps.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { RuntimeEnv } from "../runtime.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { captureEnv } from "../test-utils/env.js";
import { messageCommand } from "./message.js";

type ResetPluginRuntimeStateForTest =
  typeof import("../plugins/runtime.js").resetPluginRuntimeStateForTest;
type SetActivePluginRegistry = typeof import("../plugins/runtime.js").setActivePluginRegistry;
type CreateTestRegistry = typeof import("../test-utils/channel-plugins.js").createTestRegistry;

let resetPluginRuntimeStateForTest: ResetPluginRuntimeStateForTest;
let setActivePluginRegistry: SetActivePluginRegistry;
let createTestRegistry: CreateTestRegistry;

type RunMessageActionParams = {
  cfg?: unknown;
  action: string;
  broadcastAccountPlan?: {
    accountId: string;
    candidateChannels: string[];
    secretChannels: string[];
  };
  params: Record<string, unknown>;
  agentId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: "delegated" | "direct-operator";
  gateway?: {
    clientName?: string;
    mode?: string;
  };
};

function readOnlyMessageActionCall(): RunMessageActionParams {
  expect(runMessageActionMock).toHaveBeenCalledOnce();
  const call = runMessageActionMock.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("Expected message action call");
  }
  return call;
}

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ config, changes: [] })));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testConfig,
  loadConfig: () => testConfig,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

const resolveCommandConfigWithSecrets = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [] as string[],
  })),
);

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async (opts: {
    autoEnable?: boolean;
    config: unknown;
    env?: NodeJS.ProcessEnv;
    runtime?: { log: (message: string) => void };
  }) => {
    const result = await resolveCommandConfigWithSecrets(opts);
    for (const entry of result.diagnostics ?? []) {
      opts.runtime?.log(`[secrets] ${entry}`);
    }
    const effectiveConfig =
      opts.autoEnable === true
        ? applyPluginAutoEnable({
            config: result.resolvedConfig,
            env: opts.env ?? process.env,
          }).config
        : result.effectiveConfig;
    return {
      ...result,
      effectiveConfig,
    };
  },
}));

const getScopedChannelsCommandSecretTargets = vi.hoisted(() =>
  vi.fn(() => ({
    targetIds: new Set(["channels.telegram.token"]),
  })),
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

let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(async () => {
  ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../plugins/runtime.js"));
  ({ createTestRegistry } = await import("../test-utils/channel-plugins.js"));
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  runMessageActionMock.mockClear();
  resolveCommandConfigWithSecrets.mockClear();
  getScopedChannelsCommandSecretTargets.mockClear();
  applyPluginAutoEnable.mockClear();
  applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
  vi.mocked(runtime.log).mockClear();
  vi.mocked(runtime.error).mockClear();
  vi.mocked(runtime.exit).mockClear();
});

afterEach(() => {
  envSnapshot.restore();
  resetPluginRuntimeStateForTest();
});

function createAccountPlugin(id: "slack" | "telegram", accountIds: string[]): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => accountIds,
      inspectAccount: () => ({ enabled: true }),
      resolveAccount: () => {
        throw new Error("raw account credentials must not resolve during planning");
      },
    },
  };
}

function createLegacySingleAccountPlugin(params: {
  id: "buzz";
  resolveAccount: ChannelPlugin["config"]["resolveAccount"];
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["group"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: params.resolveAccount,
    },
  };
}

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  whatsapp: vi.fn(),
  telegram: vi.fn(),
  discord: vi.fn(),
  slack: vi.fn(),
  signal: vi.fn(),
  imessage: vi.fn(),
  ...overrides,
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

    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
      ok?: boolean;
      payload?: { results?: unknown[] };
    };
    expect(output.ok).toBe(false);
    expect(output.payload?.results).toEqual(results);
  });

  it("rejects a malformed explicit account before resolving secrets", async () => {
    await expect(runMessageCommand({ accountId: "!!!" })).rejects.toThrow("Invalid account ID");

    expect(resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
    expect(runMessageActionMock).not.toHaveBeenCalled();
  });

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
    testConfig = {
      channels: {
        slack: { accounts: { shared: { botToken: { $secret: "vault://slack/shared" } } } },
        telegram: {
          accounts: { default: { botToken: { $secret: "vault://telegram/default" } } },
        },
      },
    };

    await runMessageCommand({
      action: "broadcast",
      channel: "all",
      target: undefined,
      targets: ["slack:channel:ops", "telegram:123"],
      accountId: "shared",
    });

    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: testConfig,
      channel: undefined,
      channels: ["slack"],
      accountId: "shared",
    });
    expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
      accountId: "shared",
      candidateChannels: ["slack", "telegram"],
      secretChannels: ["slack"],
    });
    expect(slackPlugin.config.isEnabled).not.toHaveBeenCalled();
  });

  it("excludes unknown legacy-plugin accounts before account or secret resolution", async () => {
    const resolveAccount = vi.fn(() => ({ accountId: "default", enabled: true }));
    const buzzPlugin = createLegacySingleAccountPlugin({ id: "buzz", resolveAccount });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "buzz", source: "test", plugin: buzzPlugin }]),
    );
    testConfig = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.test",
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
        },
      },
    };

    await runMessageCommand({
      action: "broadcast",
      channel: "all",
      target: undefined,
      targets: ["00000000-0000-4000-8000-000000000001"],
      accountId: "ops",
    });

    expect(resolveAccount).not.toHaveBeenCalled();
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: testConfig,
      channel: undefined,
      channels: [],
      accountId: "ops",
    });
    expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
      accountId: "ops",
      candidateChannels: ["buzz"],
      secretChannels: [],
    });
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
      agents: {
        entries: {
          ops: { default: true },
          research: {},
        },
      },
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
    const json = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(json).toMatchObject({
      ok: false,
      deliveryStatus: "partial_failed",
      error: { type: "cli_error", message: "second attachment rejected" },
    });
    expect(json.payload).toEqual(sendResult);
    expect(json.messageId).toBe("first-part-1");
    expect(json.sentBeforeError).toBe(true);
  });

  it.each([
    ["rejected poll", "poll", { ok: false, error: "Poll rejected" }, "Poll rejected"],
  ] as const)("reports %s truthfully in JSON output", async (_name, action, payload, expected) => {
    runMessageActionMock.mockResolvedValueOnce({
      kind: action === "poll" ? action : "action",
      channel: "telegram",
      action,
      to: "123456",
      handledBy: "plugin",
      payload,
      dryRun: false,
    } as MessageActionResult);

    await runMessageCommand({ action });

    const json = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(json).toMatchObject({
      ok: false,
      error: { type: "cli_error", message: expected },
    });
    expect(json.payload).toEqual(payload);
    expect(json).not.toHaveProperty("deliveryStatus");
  });

  it("rejects unknown message actions before dispatch", async () => {
    await expect(runMessageCommand({ action: "nope" })).rejects.toThrow("Unknown message action");
    expect(runMessageActionMock).not.toHaveBeenCalled();
  });
});

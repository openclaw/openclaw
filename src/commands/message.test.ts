import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ config, changes: [] })));
vi.mock("../config/config.js", () => ({
  loadConfig: () => testConfig,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

const { resolveCommandConfigWithSecrets, callGatewayMock } = vi.hoisted(() => ({
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [] as string[],
  })),
  callGatewayMock: vi.fn(),
}));

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

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  callGatewayLeastPrivilege: callGatewayMock,
  randomIdempotencyKey: () => "idem-1",
}));

const handleDiscordAction = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } })),
);

const handleTelegramAction = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } })),
);

let messageCommand: typeof import("./message.js").messageCommand;

let envSnapshot: ReturnType<typeof captureEnv>;
const EMPTY_TEST_REGISTRY = createTestRegistry([]);

beforeAll(async () => {
  ({ messageCommand } = await import("./message.js"));
});

beforeEach(() => {
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  setActivePluginRegistry(EMPTY_TEST_REGISTRY);
  callGatewayMock.mockClear();
  handleDiscordAction.mockClear();
  handleTelegramAction.mockClear();
  resolveCommandConfigWithSecrets.mockClear();
  applyPluginAutoEnable.mockClear();
  applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
});

afterEach(() => {
  envSnapshot.restore();
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
  ...overrides,
});

const createStubPlugin = (params: {
  id: ChannelPlugin["id"];
  label?: string;
  actions?: ChannelMessageActionAdapter;
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    isConfigured: async () => true,
  },
  actions: params.actions,
  outbound: params.outbound,
});

type ChannelActionParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>
>[0];

const createDiscordPollPluginRegistration = () => ({
  pluginId: "discord",
  source: "test",
  plugin: createStubPlugin({
    id: "discord",
    label: "Discord",
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleDiscordAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

const createTelegramSendPluginRegistration = () => ({
  pluginId: "telegram",
  source: "test",
  plugin: createStubPlugin({
    id: "telegram",
    label: "Telegram",
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

const createTelegramPollPluginRegistration = () => ({
  pluginId: "telegram",
  source: "test",
  plugin: createStubPlugin({
    id: "telegram",
    label: "Telegram",
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
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

async function runTelegramDirectOutboundSend(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  mockResolvedCommandConfig(params);
  const sendText = vi.fn(async (_ctx: { cfg?: unknown; to?: string; text?: string }) => ({
    channel: "telegram" as const,
    messageId: "msg-1",
    chatId: "123456",
  }));
  const sendMedia = vi.fn(async (_ctx: { cfg?: unknown }) => ({
    channel: "telegram" as const,
    messageId: "msg-2",
    chatId: "123456",
  }));
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createStubPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            sendText,
            sendMedia,
          },
        }),
      },
    ]),
  );

  const deps = makeDeps();
  await messageCommand(
    {
      action: "send",
      channel: "telegram",
      target: "123456",
      message: "hi",
    },
    deps,
    runtime,
  );

  return { sendText };
}

describe("messageCommand", () => {
  it("threads resolved SecretRef config into outbound adapter sends", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    const { sendText } = await runTelegramDirectOutboundSend({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
        to: "123456",
        text: "hi",
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
  });

  it("keeps local-fallback resolved cfg in outbound adapter sends", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    const locallyResolvedConfig = {
      channels: {
        telegram: {
          token: "12345:local-fallback-token",
        },
      },
    };
    const { sendText } = await runTelegramDirectOutboundSend({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: locallyResolvedConfig as unknown as Record<string, unknown>,
      diagnostics: ["gateway secrets.resolve unavailable; used local resolver fallback."],
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: locallyResolvedConfig,
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("[secrets] gateway secrets.resolve unavailable"),
    );
  });

  it("defaults channel when only one configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalled();
  });

  it("defaults channel from the auto-enabled config snapshot when only one channel becomes configured", async () => {
    const rawConfig = {};
    const resolvedConfig = {};
    const autoEnabledConfig = {
      channels: {
        telegram: {
          token: "12345:auto-enabled-token",
        },
      },
      plugins: { allow: ["telegram"] },
    };
    mockResolvedCommandConfig({
      rawConfig,
      resolvedConfig,
      diagnostics: [],
    });
    applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );

    const deps = makeDeps();
    await messageCommand(
      {
        target: "123456",
        message: "hi",
      },
      deps,
      runtime,
    );

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
    });
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        to: "123456",
      }),
      autoEnabledConfig,
    );
  });

  it("requires channel when multiple configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    process.env.DISCORD_BOT_TOKEN = "token-discord";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await expect(
      messageCommand(
        {
          target: "123",
          message: "hi",
        },
        deps,
        runtime,
      ),
    ).rejects.toThrow(/Channel is required/);
  });

  it("sends via gateway for WhatsApp", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: createStubPlugin({
            id: "whatsapp",
            label: "WhatsApp",
            outbound: {
              deliveryMode: "gateway",
            },
          }),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "send",
        channel: "whatsapp",
        target: "+15551234567",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalled();
  });

  it("routes discord polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "discord",
        target: "channel:123456789",
        pollQuestion: "Snack?",
        pollOption: ["Pizza", "Sushi"],
      },
      deps,
      runtime,
    );
    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "channel:123456789",
      }),
      expect.any(Object),
    );
  });

  it("routes telegram polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "telegram",
        target: "123456789",
        pollQuestion: "Ship it?",
        pollOption: ["Yes", "No"],
        pollDurationSeconds: 120,
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "123456789",
      }),
      expect.any(Object),
    );
  });
});

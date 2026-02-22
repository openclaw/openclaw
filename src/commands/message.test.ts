import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  callGatewayLeastPrivilege: callGatewayMock,
  randomIdempotencyKey: () => "idem-1",
}));

const webAuthExists = vi.fn(async () => false);
vi.mock("../web/session.js", () => ({
  webAuthExists,
}));

const handleDiscordAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
vi.mock("../agents/tools/discord-actions.js", () => ({
  handleDiscordAction,
}));

const handleSlackAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
vi.mock("../agents/tools/slack-actions.js", () => ({
  handleSlackAction,
}));

const handleTelegramAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
vi.mock("../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction,
}));

const handleWhatsAppAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
vi.mock("../agents/tools/whatsapp-actions.js", () => ({
  handleWhatsAppAction,
}));

let envSnapshot: ReturnType<typeof captureEnv>;

const setRegistry = async (registry: ReturnType<typeof createTestRegistry>) => {
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  setActivePluginRegistry(registry);
};

beforeEach(async () => {
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  await setRegistry(createTestRegistry([]));
  callGatewayMock.mockClear();
  webAuthExists.mockClear().mockResolvedValue(false);
  handleDiscordAction.mockClear();
  handleSlackAction.mockClear();
  handleTelegramAction.mockClear();
  handleWhatsAppAction.mockClear();
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
      listActions: () => ["poll"],
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
      listActions: () => ["send"],
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
  }),
});

const { messageCommand } = await import("./message.js");

describe("messageCommand", () => {
  it("defaults channel when only one configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    await setRegistry(
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

  it("requires channel when multiple configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    process.env.DISCORD_BOT_TOKEN = "token-discord";
    await setRegistry(
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
    await setRegistry(
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
    await setRegistry(
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
});

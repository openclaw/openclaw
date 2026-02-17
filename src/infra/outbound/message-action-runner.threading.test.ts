import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

async function runThreadingAction(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    agentId: "main",
  });
  return mocks.executeSendAction.mock.calls[0]?.[0] as {
    threadId?: string;
    replyToId?: string;
    ctx?: { agentId?: string; mirror?: { sessionKey?: string }; params?: Record<string, unknown> };
  };
}

function mockHandledSendAction() {
  mocks.executeSendAction.mockResolvedValue({
    handledBy: "plugin",
    payload: {},
  });
}

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

describe("runMessageAction threading auto-injection", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js");
    const { setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js");
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setTelegramRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executeSendAction.mockReset();
    mocks.recordSessionMetaFromInbound.mockReset();
  });

  it("uses toolContext thread when auto-threading is active", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "channel:C123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "111.222",
        replyToMode: "all",
      },
    });

    expect(call?.ctx?.agentId).toBe("main");
    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:111.222");
  });

  it("matches auto-threading when channel ids differ in case", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "channel:c123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "333.444",
        replyToMode: "all",
      },
    });

    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:333.444");
  });

  it("auto-injects telegram threadId from toolContext when omitted", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("skips telegram auto-threading when target chat differs", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:999",
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("matches telegram target with internal prefix variations", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:group:123",
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("uses explicit telegram threadId when provided", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        threadId: "999",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.threadId).toBe("999");
    expect(call?.ctx?.params?.threadId).toBe("999");
  });

  it("threads explicit replyTo through executeSendAction", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        replyTo: "777",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.replyToId).toBe("777");
    expect(call?.ctx?.params?.replyTo).toBe("777");
  });
});

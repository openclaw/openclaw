import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  __clearSignalReactionTargetCacheForTests,
  recordSignalReactionTarget,
} from "../../signal/reaction-target-cache.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  dispatchChannelMessageAction: vi.fn(),
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

vi.mock("../../channels/plugins/message-actions.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/message-actions.js")>(
    "../../channels/plugins/message-actions.js",
  );
  return {
    ...actual,
    dispatchChannelMessageAction: (...args: unknown[]) =>
      mocks.dispatchChannelMessageAction(...args),
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
    mocks.dispatchChannelMessageAction.mockReset();
    __clearSignalReactionTargetCacheForTests();
  });

  it("uses toolContext thread when auto-threading is active", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "111.222",
        replyToMode: "all",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.agentId).toBe("main");
    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:111.222");
  });

  it("matches auto-threading when channel ids differ in case", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:c123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "333.444",
        replyToMode: "all",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0];
    expect(call?.ctx?.mirror?.sessionKey).toBe("agent:main:slack:channel:c123:thread:333.444");
  });

  it("auto-injects telegram threadId from toolContext when omitted", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0] as {
      threadId?: string;
      ctx?: { params?: Record<string, unknown> };
    };
    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("skips telegram auto-threading when target chat differs", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:999",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0] as {
      ctx?: { params?: Record<string, unknown> };
    };
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("matches telegram target with internal prefix variations", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:group:123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0] as {
      ctx?: { params?: Record<string, unknown> };
    };
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("uses explicit telegram threadId when provided", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        threadId: "999",
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0] as {
      threadId?: string;
      ctx?: { params?: Record<string, unknown> };
    };
    expect(call?.threadId).toBe("999");
    expect(call?.ctx?.params?.threadId).toBe("999");
  });

  it("threads explicit replyTo through executeSendAction", async () => {
    mocks.executeSendAction.mockResolvedValue({
      handledBy: "plugin",
      payload: {},
    });

    await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        replyTo: "777",
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
      agentId: "main",
    });

    const call = mocks.executeSendAction.mock.calls[0]?.[0] as {
      replyToId?: string;
      ctx?: { params?: Record<string, unknown> };
    };
    expect(call?.replyToId).toBe("777");
    expect(call?.ctx?.params?.replyTo).toBe("777");
  });

  it("hydrates signal group reaction targetAuthorUuid from inbound cache", async () => {
    const groupId = "imrDE/AziMTrojCb1ngE9WcREGjKxjRq30krncLOZnM=";
    recordSignalReactionTarget({
      groupId,
      messageId: "1737630212345",
      senderId: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });
    mocks.dispatchChannelMessageAction.mockResolvedValue({ ok: true });

    await runMessageAction({
      cfg: {
        channels: {
          signal: {
            account: "+15550001111",
            reactionLevel: "minimal",
            actions: { reactions: true },
          },
        },
      } as OpenClawConfig,
      action: "react",
      params: {
        channel: "signal",
        target: `group:${groupId}`,
        messageId: "1737630212345",
        emoji: "✅",
      },
    });

    const call = mocks.dispatchChannelMessageAction.mock.calls[0]?.[0] as
      | { params?: Record<string, unknown> }
      | undefined;
    expect(call?.params?.targetAuthorUuid).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(call?.params?.targetAuthor).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  directOutbound,
  runDryAction,
  runDrySend,
  slackConfig,
  slackTestPlugin,
  telegramTestPlugin,
  whatsappConfig,
  whatsappTestPlugin,
} from "./message-action-runner.test-helpers.js";

const imessageTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "imessage",
    label: "iMessage",
    docsPath: "/channels/imessage",
    capabilities: { chatTypes: ["direct", "group"], media: true },
  }),
  meta: {
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
    docsPath: "/channels/imessage",
    blurb: "iMessage test stub.",
    aliases: ["imsg"],
  },
  outbound: directOutbound,
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<handle|chat_id:ID>",
    },
  },
};

describe("runMessageAction context isolation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackTestPlugin,
        },
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: whatsappTestPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramTestPlugin,
        },
        {
          pluginId: "imessage",
          source: "test",
          plugin: imessageTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      name: "allows send when target matches current channel",
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "accepts legacy to parameter for send",
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        to: "#C12345678",
        message: "hi",
      },
    },
    {
      name: "defaults to current channel when target is omitted",
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows media-only send when target matches current channel",
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows send when poll booleans are explicitly false",
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollMulti: false,
        pollAnonymous: false,
        pollPublic: false,
      },
      toolContext: { currentChannelId: "C12345678" },
    },
  ])("$name", async ({ cfg, actionParams, toolContext }) => {
    const result = await runDrySend({
      cfg,
      actionParams,
      ...(toolContext ? { toolContext } : {}),
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "send when target differs from current slack channel",
      run: () =>
        runDrySend({
          cfg: slackConfig,
          actionParams: {
            channel: "slack",
            target: "channel:C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        }),
      expectedKind: "send",
    },
    {
      name: "thread-reply when channelId differs from current slack channel",
      run: () =>
        runDryAction({
          cfg: slackConfig,
          action: "thread-reply",
          actionParams: {
            channel: "slack",
            target: "C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        }),
      expectedKind: "action",
    },
  ])("blocks cross-context UI handoff for $name", async ({ run, expectedKind }) => {
    const result = await run();
    expect(result.kind).toBe(expectedKind);
  });

  it.each([
    {
      name: "whatsapp match",
      channel: "whatsapp",
      target: "123@g.us",
      currentChannelId: "123@g.us",
    },
    {
      name: "imessage match",
      channel: "imessage",
      target: "imessage:+15551234567",
      currentChannelId: "imessage:+15551234567",
    },
    {
      name: "whatsapp mismatch",
      channel: "whatsapp",
      target: "456@g.us",
      currentChannelId: "123@g.us",
      currentChannelProvider: "whatsapp",
    },
    {
      name: "imessage mismatch",
      channel: "imessage",
      target: "imessage:+15551230000",
      currentChannelId: "imessage:+15551234567",
      currentChannelProvider: "imessage",
    },
  ] as const)("$name", async (testCase) => {
    const result = await runDrySend({
      cfg: whatsappConfig,
      actionParams: {
        channel: testCase.channel,
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: testCase.currentChannelId,
        ...(testCase.currentChannelProvider
          ? { currentChannelProvider: testCase.currentChannelProvider }
          : {}),
      },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "infers channel + target from tool context when missing",
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
          telegram: {
            token: "tg-test",
          },
        },
      } as OpenClawConfig,
      action: "send" as const,
      actionParams: {
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      expectedKind: "send",
      expectedChannel: "slack",
    },
    {
      name: "falls back to tool-context provider when channel param is an id",
      cfg: slackConfig,
      action: "send" as const,
      actionParams: {
        channel: "C12345678",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      expectedKind: "send",
      expectedChannel: "slack",
    },
    {
      name: "falls back to tool-context provider for broadcast channel ids",
      cfg: slackConfig,
      action: "broadcast" as const,
      actionParams: {
        targets: ["channel:C12345678"],
        channel: "C12345678",
        message: "hi",
      },
      toolContext: { currentChannelProvider: "slack" },
      expectedKind: "broadcast",
      expectedChannel: "slack",
    },
  ])("$name", async ({ cfg, action, actionParams, toolContext, expectedKind, expectedChannel }) => {
    const result = await runDryAction({
      cfg,
      action,
      actionParams,
      toolContext,
    });

    expect(result.kind).toBe(expectedKind);
    expect(result.channel).toBe(expectedChannel);
  });

  it.each([
    {
      name: "blocks cross-provider sends by default",
      action: "send" as const,
      cfg: slackConfig,
      actionParams: {
        channel: "telegram",
        target: "@opsbot",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context when disabled",
      action: "send" as const,
      cfg: {
        ...slackConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "slack",
        target: "channel:C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context uploads when disabled",
      action: "upload-file" as const,
      cfg: {
        ...slackConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "slack",
        target: "channel:C99999999",
        filePath: "/tmp/report.png",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "rejects channel ids that resolve to user targets",
      action: "channel-info" as const,
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        channelId: "U12345678",
      },
      message: 'Channel id "U12345678" resolved to a user target.',
    },
  ])("$name", async ({ action, cfg, actionParams, toolContext, message }) => {
    await expect(
      runDryAction({
        cfg,
        action,
        actionParams,
        toolContext,
      }),
    ).rejects.toThrow(message);
  });

  it.each([
    {
      name: "send",
      run: (abortSignal: AbortSignal) =>
        runDrySend({
          cfg: slackConfig,
          actionParams: {
            channel: "slack",
            target: "#C12345678",
            message: "hi",
          },
          abortSignal,
        }),
    },
    {
      name: "broadcast",
      run: (abortSignal: AbortSignal) =>
        runDryAction({
          cfg: slackConfig,
          action: "broadcast",
          actionParams: {
            targets: ["channel:C12345678"],
            channel: "slack",
            message: "hi",
          },
          abortSignal,
        }),
    },
  ])("aborts $name when abortSignal is already aborted", async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

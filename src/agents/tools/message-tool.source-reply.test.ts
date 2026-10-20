import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import {
  directOutbound,
  workspaceConfig,
  workspaceTestPlugin,
} from "../../infra/outbound/message-action-runner.test-support.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createMessageTool } from "./message-tool-execution.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

const actualRunMessageAction = messageActionRunner.runMessageAction;
const mocks = {
  runMessageAction: vi.fn<typeof actualRunMessageAction>(),
  resolveCommandSecretRefsViaGateway: vi.fn(
    commandSecretGateway.resolveCommandSecretRefsViaGateway,
  ),
};

function registerPlugins(plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.resolveCommandSecretRefsViaGateway.mockClear();
  vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(mocks.runMessageAction);
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    mocks.resolveCommandSecretRefsViaGateway,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("completion source-reply authority", () => {
  function createRestrictedTool(overrides: Partial<MessageToolOptions> = {}) {
    const config = overrides.config ?? {};
    setRuntimeConfigSnapshot(config);
    registerPlugins({
      ...createChannelTestPluginBase({
        id: "discord",
        config: { listAccountIds: () => ["source-account"] },
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send", "delete", "ban"] }),
        messageActionTargetAliases: {
          send: { aliases: ["destination"], deliveryTargetAliases: ["destination"] },
        },
      },
    });
    return createMessageTool({
      config,
      sourceReplyOnly: true,
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "discord",
      currentChannelId: "channel:source",
      currentThreadTs: "thread-1",
      currentMessageId: "message-1",
      agentAccountId: "source-account",
      ...overrides,
    });
  }

  it.each([
    ["delete", { action: "delete" }],
    ["other provider", { action: "send", channel: "telegram" }],
    ["other target", { action: "send", target: "channel:other" }],
    ["legacy recipient", { action: "send", to: "channel:other" }],
    ["channel-id alias", { action: "send", channelId: "channel:other" }],
    ["plugin target alias", { action: "send", destination: "channel:other" }],
    ["multiple targets", { action: "send", targets: ["channel:other"] }],
    ["other account", { action: "send", accountId: "other-account" }],
    ["other thread", { action: "send", threadId: "thread-2" }],
    ["other reply", { action: "send", replyTo: "message-2" }],
    ["remote gateway", { action: "send", gatewayUrl: "wss://other.example" }],
    ["gateway token", { action: "send", gatewayToken: "other-token" }],
    ["inline buffer", { action: "send", buffer: "c2VjcmV0" }],
    ["unknown plugin argument", { action: "send", pluginFile: "./AGENTS.md" }],
    ["inline reply route", { action: "send", message: "[[reply_to:message-2]] stolen thread" }],
    [
      "reply directive inside a media-only URL",
      {
        action: "send",
        media: undefined,
        message: "MEDIA:https://example.com/a[[reply_to:message-2]].png",
      },
    ],
    [
      "reply directive inside a media caption",
      {
        action: "send",
        message: "",
        caption: "MEDIA:https://example.com/a[[reply_to:message-2]].png",
      },
    ],
    [
      "audio directive inside a media URL",
      { action: "send", message: "MEDIA:https://example.com/a[[audio_as_voice]].ogg" },
    ],
    [
      "caption reply route",
      { action: "send", message: "", caption: "[[reply_to:message-2]] stolen thread" },
    ],
    [
      "caption audio directive",
      { action: "send", message: " ", caption: "[[audio_as_voice]] completion" },
    ],
    [
      "reply directive after an indented fence",
      { action: "send", message: "    ```text\n[[reply_to:message-2]] stolen thread\n```" },
    ],
    ["inline audio directive", { action: "send", message: "[[audio_as_voice]] completion" }],
    [
      "reply directive inside citation marker",
      { action: "send", message: "cite[[reply_to:message-2]]" },
    ],
    [
      "audio directive escaping a tool-call-owned Markdown fence",
      {
        action: "send",
        message: [
          "<function=read><parameter=x>",
          "```text",
          "</parameter></function>",
          "[[audio_as_voice]] completion",
          "```",
        ].join("\n"),
      },
    ],
    [
      "sanitizer-assembled reply directive",
      { action: "send", message: "[[reply_<final>to:message-2]] stolen thread" },
    ],
  ])("rejects %s before resolving secrets or dispatching", async (_name, args) => {
    const tool = createRestrictedTool();

    await expect(
      tool.execute("restricted", {
        message: "completion",
        media: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
        ...args,
      }),
    ).rejects.toThrow(/Completion source replies/);
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  function createCompletionMediaTool() {
    mocks.runMessageAction.mockImplementation(actualRunMessageAction);
    const config = { ...workspaceConfig, tools: { fs: { workspaceOnly: true } } };
    setRuntimeConfigSnapshot(config);
    const sendMedia = vi.fn(async (_ctx: ChannelOutboundContext) => ({
      channel: "workspace",
      messageId: "photo-1",
    }));
    registerPlugins({
      ...workspaceTestPlugin,
      outbound: {
        ...directOutbound,
        extractMarkdownImages: true,
        sendMedia: async (ctx) => {
          // This provider accepts remote URLs; local uploads use the shared media policy.
          if (ctx.mediaUrl && !ctx.mediaUrl.startsWith("https://")) {
            await loadWebMedia(ctx.mediaUrl, buildOutboundMediaLoadOptions(ctx));
          }
          return sendMedia(ctx);
        },
      },
    });
    const tool = createMessageTool({
      config,
      sourceReplyOnly: true,
      sourceReplyDeliveryMode: "message_tool_only",
      agentSessionKey: "agent:main:workspace:group:SOURCE",
      currentChannelProvider: "workspace",
      currentChannelId: "SOURCE",
      currentThreadTs: "thread-1",
      currentMessageId: "message-1",
    });
    return { tool, sendMedia };
  }

  it("delivers completion media and attachments to the current source through normal sends", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "completion-media-" }, async () => {
      const { tool, sendMedia } = createCompletionMediaTool();
      const url = "https://example.com/photo.png";
      for (const args of [
        { media: url, message: "Replacement photo" },
        { media: url, caption: "Replacement photo" },
        { media: url, filename: "photo.png", contentType: "image/png" },
        { media: url, mimeType: "image/png" },
        { attachments: [{ media: url, name: "photo.png" }] },
        { message: `MEDIA:${url}` },
        { message: `![Replacement photo](${url})` },
      ]) {
        sendMedia.mockClear();
        const result = await tool.execute("completion-media", {
          action: "send",
          replyTo: "message-1",
          threadId: "thread-1",
          ...args,
        });
        expect(sendMedia).toHaveBeenCalledTimes(1);
        expect(sendMedia).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "SOURCE",
            mediaUrl: url,
            threadId: "thread-1",
            replyToId: "message-1",
          }),
        );
        expect(result.details).toHaveProperty("messageDelivery.sourceReplyDelivered", true);
      }
    });
  });

  it("applies normal local media roots and empty-send validation to completion replies", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "completion-media-" },
      async ({ stateDir }) => {
        const { tool, sendMedia } = createCompletionMediaTool();
        // State files outside managed media/workspace roots must never become attachments.
        const outside = `${stateDir}/private.txt`;
        const directivePath = pathToFileURL(outside).href;
        await fs.writeFile(outside, "private fixture");
        for (const args of [
          { media: outside },
          { attachments: [{ media: outside }] },
          { message: `MEDIA:${directivePath}` },
          { message: `completion\\nMEDIA:${directivePath}` },
          { message: `completion\nMEciteDIA:${directivePath}` },
        ]) {
          const result = await tool.execute("outside-roots", {
            action: "send",
            filename: "photo.png",
            contentType: "image/png",
            ...args,
          });
          expect(result.details).toMatchObject({
            deliveryStatus: "failed",
            error: expect.stringMatching(/not under an allowed directory/),
            messageDelivery: { status: "failed" },
          });
          expect(result.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        }
        await expect(tool.execute("empty", { action: "send", message: " \n\t " })).rejects.toThrow(
          "send requires text or media",
        );
        expect(sendMedia).not.toHaveBeenCalled();
      },
    );
  });

  it("allows shared final controls and matched canonical source-thread text sends", async () => {
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "discord",
      to: "channel:source",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    });
    const tool = createRestrictedTool();

    await tool.execute("implicit", { action: "send", message: "completion", final: true });
    await tool.execute("literal-no-reply", { action: "send", message: "NO_REPLY", final: true });
    await tool.execute("media-prose", {
      action: "send",
      message: "See the MEDIA: section for details.",
    });
    await tool.execute("media-code-example", {
      action: "send",
      message: "Example:\n```text\nMEDIA:./AGENTS.md\n```",
    });
    await tool.execute("explicit", {
      action: "send",
      channel: "discord",
      target: "channel:source",
      accountId: "source-account",
      threadId: "thread-1",
      replyTo: "message-1",
      message: "completion",
      final: false,
    });

    expect(mocks.runMessageAction).toHaveBeenCalledTimes(5);
    expect(mocks.runMessageAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: expect.objectContaining({ message: "NO_REPLY" }) }),
    );
  });

  it("fails closed when the authoritative source target is missing", async () => {
    const tool = createRestrictedTool({ currentChannelId: undefined });

    await expect(
      tool.execute("missing-source", { action: "send", message: "completion" }),
    ).rejects.toThrow("authoritative current conversation");
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });
});

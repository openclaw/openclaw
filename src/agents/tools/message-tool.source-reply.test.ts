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
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createMessageTool } from "./message-tool-execution.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

const source = {
  sourceReplyOnly: true,
  sourceReplyDeliveryMode: "message_tool_only",
  currentThreadTs: "thread-1",
  currentMessageId: "message-1",
  currentChannelProvider: "workspace",
  currentChannelId: "SOURCE",
  agentAccountId: "default",
} satisfies Partial<MessageToolOptions>;

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.spyOn(messageActionRunner, "runMessageAction");
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway");
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("completion source-reply authority", () => {
  const replyTag = "[[reply_to:message-2]]";
  const audioTag = "[[audio_as_voice]]";
  function createFixture(overrides: Partial<MessageToolOptions> = {}) {
    const config = { ...workspaceConfig, tools: { fs: { workspaceOnly: true } } };
    setRuntimeConfigSnapshot(config);
    const receipt = { channel: "workspace", messageId: "photo-1" };
    const sendMedia = vi.fn(async (_ctx: ChannelOutboundContext) => receipt);
    const plugin: ChannelPlugin = {
      ...workspaceTestPlugin,
      actions: {
        describeMessageTool: () => ({ actions: ["send", "delete", "ban"] }),
        messageActionTargetAliases: {
          send: { aliases: ["destination"], deliveryTargetAliases: ["destination"] },
        },
      },
      outbound: {
        ...directOutbound,
        extractMarkdownImages: true,
        sendMedia: async (ctx: ChannelOutboundContext) => {
          if (ctx.mediaUrl && !ctx.mediaUrl.startsWith("https://")) {
            await loadWebMedia(ctx.mediaUrl, buildOutboundMediaLoadOptions(ctx));
          }
          return sendMedia(ctx);
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    const tool = createMessageTool({
      ...source,
      config,
      ...overrides,
    });
    return { tool, sendMedia };
  }

  it.each([
    { action: "delete" },
    { channel: "telegram" },
    { target: "channel:other" },
    { to: "channel:other" },
    { channelId: "channel:other" },
    { destination: "channel:other" },
    { accountId: "other-account" },
    { threadId: "thread-2" },
    { replyTo: "message-2" },
    { gatewayToken: "other-token" },
    { message: `${replyTag} stolen thread` },
    { media: undefined, message: `MEDIA:https://example.com/a${replyTag}.png` },
    { message: "", caption: `MEDIA:https://example.com/a${replyTag}.png` },
    { message: `MEDIA:https://example.com/a${audioTag}.ogg` },
    { message: "", caption: `${replyTag} stolen thread` },
    { message: " ", caption: `${audioTag} completion` },
    { message: "    ```text\n[[reply_to:message-2]] stolen thread\n```" },
    { message: `${audioTag} completion` },
    { message: `cite${replyTag}` },
    {
      message: `<function=read><parameter=x>\n\`\`\`text\n</parameter></function>\n${audioTag} completion\n\`\`\``,
    },
    { message: "[[reply_<final>to:message-2]] stolen thread" },
  ])("rejects %j before resolving secrets or dispatching", async (args) => {
    const { tool } = createFixture();

    await expect(
      tool.execute("restricted", {
        action: "send",
        message: "completion",
        media: "https://example.com/photo.png",
        ...args,
      }),
    ).rejects.toThrow(/Completion source replies/);
    expect(commandSecretGateway.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(messageActionRunner.runMessageAction).not.toHaveBeenCalled();
  });

  it("delivers completion media and attachments to the current source through normal sends", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "completion-media-" }, async () => {
      const { tool, sendMedia } = createFixture({
        agentSessionKey: "agent:main:workspace:group:SOURCE",
      });
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
        expect(sendMedia.mock.calls).toMatchObject([
          [
            {
              to: "SOURCE",
              mediaUrl: url,
              threadId: "thread-1",
              replyToId: "message-1",
            },
          ],
        ]);
        expect(result.details).toHaveProperty("messageDelivery.sourceReplyDelivered", true);
      }
    });
  });

  it("applies normal local media roots and empty-send validation to completion replies", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "completion-media-" },
      async ({ stateDir }) => {
        const { tool, sendMedia } = createFixture({
          agentSessionKey: "agent:main:workspace:group:SOURCE",
        });
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
    const send = vi.mocked(messageActionRunner.runMessageAction).mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "workspace",
      to: "SOURCE",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    });
    const { tool } = createFixture();
    for (const args of [
      { message: "completion", final: true },
      { message: "NO_REPLY", final: true },
      { message: "See the MEDIA: section for details." },
      { message: "Example:\n```text\nMEDIA:./AGENTS.md\n```" },
      {
        channel: "workspace",
        target: "SOURCE",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "message-1",
        message: "completion",
        final: false,
      },
    ]) {
      await tool.execute("allowed", { action: "send", ...args });
    }

    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: expect.objectContaining({ message: "NO_REPLY" }) }),
    );
  });

  it("fails closed when the authoritative source target is missing", async () => {
    const { tool } = createFixture({ currentChannelId: undefined });

    await expect(
      tool.execute("missing-source", { action: "send", message: "completion" }),
    ).rejects.toThrow("authoritative current conversation");
    expect(commandSecretGateway.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });
});

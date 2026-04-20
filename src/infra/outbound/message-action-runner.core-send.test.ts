import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("../../media/web-media.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
    "../../media/web-media.js",
  );
  return {
    ...actual,
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
  };
});

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    loadWebMediaMock.mockReset();
  });

  it("promotes caption to message for media sends when message is empty", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m1",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t1",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        caption: "caption-only text",
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption-only text",
        mediaUrl: "https://example.com/cat.png",
      }),
    );
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it("does not misclassify send as poll when zero-valued poll params are present", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m2",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t2",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/file.txt",
        message: "hello",
        pollDurationHours: 0,
        pollDurationSeconds: 0,
        pollMulti: false,
        pollQuestion: "",
        pollOption: [],
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        mediaUrl: "https://example.com/file.txt",
      }),
    );
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it("does not preload media for plugin send handlers unless they opt in", async () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        media: params.media,
        buffer: params.buffer ?? null,
      }),
    );
    const plugin: ChannelPlugin = {
      id: "pluginchat",
      meta: {
        id: "pluginchat",
        label: "Plugin Chat",
        selectionLabel: "Plugin Chat",
        docsPath: "/channels/pluginchat",
        blurb: "Plugin chat test channel.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "pluginchat", source: "test", plugin }]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          pluginchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "pluginchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        message: "hello",
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("plugin");
    expect(result.payload).toMatchObject({
      ok: true,
      media: "https://example.com/cat.png",
      buffer: null,
    });
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it("preloads media for plugin send handlers that opt in", async () => {
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("cat"),
      contentType: "image/png",
      kind: "image",
      fileName: "cat.png",
    });
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        buffer: params.buffer,
        filename: params.filename,
        contentType: params.contentType,
      }),
    );
    const plugin: ChannelPlugin = {
      id: "bufferchat",
      meta: {
        id: "bufferchat",
        label: "Buffer Chat",
        selectionLabel: "Buffer Chat",
        docsPath: "/channels/bufferchat",
        blurb: "Buffer chat test channel.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        preloadSendMedia: true,
        handleAction,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bufferchat", source: "test", plugin }]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          bufferchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "bufferchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        message: "hello",
      },
      dryRun: false,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/cat.png",
      expect.objectContaining({}),
    );
    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("plugin");
    expect(result.payload).toMatchObject({
      ok: true,
      buffer: Buffer.from("cat").toString("base64"),
      filename: "cat.png",
      contentType: "image/png",
    });
  });
});

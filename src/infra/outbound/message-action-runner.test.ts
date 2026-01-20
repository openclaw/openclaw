import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createIMessageTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { loadWebMedia } from "../../web/media.js";
import { runMessageAction } from "./message-action-runner.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";

vi.mock("../../web/media.js", () => ({
  loadWebMedia: vi.fn(),
}));

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as ClawdbotConfig;

const whatsappConfig = {
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
} as ClawdbotConfig;

describe("runMessageAction context isolation", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js");
    const { setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js");
    const { setWhatsAppRuntime } = await import("../../../extensions/whatsapp/src/runtime.js");
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setTelegramRuntime(runtime);
    setWhatsAppRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: whatsappPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("maps sendAttachment media to buffer + filename", async () => {
    const filePath = path.join(os.tmpdir(), `clawdbot-attachment-${Date.now()}.txt`);
    await fs.writeFile(filePath, "hello");

    const handleAction = vi.fn(async (ctx) => {
      return jsonResult({ ok: true, params: ctx.params });
    });

    const testPlugin: ChannelPlugin = {
      id: "bluebubbles",
      meta: {
        id: "bluebubbles",
        label: "BlueBubbles",
        selectionLabel: "BlueBubbles",
        docsPath: "/channels/bluebubbles",
        blurb: "BlueBubbles test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          hint: "<target>",
        },
        normalizeTarget: (raw) => raw.trim(),
      },
      actions: {
        listActions: () => ["sendAttachment"],
        handleAction: handleAction as NonNullable<ChannelPlugin["actions"]>["handleAction"],
      },
    };

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bluebubbles", source: "test", plugin: testPlugin }]),
    );

    try {
      const result = await runMessageAction({
        cfg: { channels: { bluebubbles: {} } } as ClawdbotConfig,
        action: "sendAttachment",
        params: {
          channel: "bluebubbles",
          target: "chat_guid:TEST",
          media: filePath,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("action");
      expect(handleAction).toHaveBeenCalledTimes(1);
      const params = handleAction.mock.calls[0]?.[0]?.params as Record<string, unknown>;
      expect(params.filename).toBe(path.basename(filePath));
      expect(params.buffer).toBe(Buffer.from("hello").toString("base64"));
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  });
  it("allows send when target matches current channel", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("defaults to current channel when target is omitted", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("allows media-only send when target matches current channel", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          channel: "slack",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
        dryRun: true,
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("blocks send when target differs from current channel", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks thread-reply when channelId differs from current channel", async () => {
    const result = await runMessageAction({
      cfg: slackConfig,
      action: "thread-reply",
      params: {
        channel: "slack",
        target: "C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      dryRun: true,
    });

    expect(result.kind).toBe("action");
  });

  it("allows WhatsApp send when target matches current chat", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "whatsapp",
        target: "123@g.us",
        message: "hi",
      },
      toolContext: { currentChannelId: "123@g.us" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks WhatsApp send when target differs from current chat", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "whatsapp",
        target: "456@g.us",
        message: "hi",
      },
      toolContext: { currentChannelId: "123@g.us", currentChannelProvider: "whatsapp" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("allows iMessage send when target matches current handle", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551234567",
        message: "hi",
      },
      toolContext: { currentChannelId: "imessage:+15551234567" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("blocks iMessage send when target differs from current handle", async () => {
    const result = await runMessageAction({
      cfg: whatsappConfig,
      action: "send",
      params: {
        channel: "imessage",
        target: "imessage:+15551230000",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "imessage:+15551234567",
        currentChannelProvider: "imessage",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it("infers channel + target from tool context when missing", async () => {
    const multiConfig = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
        telegram: {
          token: "tg-test",
        },
      },
    } as ClawdbotConfig;

    const result = await runMessageAction({
      cfg: multiConfig,
      action: "send",
      params: {
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
    expect(result.channel).toBe("slack");
  });

  it("blocks cross-provider sends by default", async () => {
    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          channel: "telegram",
          target: "telegram:@ops",
          message: "hi",
        },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });

  it("blocks same-provider cross-context when disabled", async () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: {
          crossContext: {
            allowWithinProvider: false,
          },
        },
      },
    } as ClawdbotConfig;

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "slack",
          target: "channel:C99999999",
          message: "hi",
        },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });
});

describe("runMessageAction sendAttachment hydration", () => {
  const attachmentPlugin: ChannelPlugin = {
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
      docsPath: "/channels/bluebubbles",
      blurb: "BlueBubbles test plugin.",
    },
    capabilities: { chatTypes: ["direct"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    actions: {
      listActions: () => ["sendAttachment"],
      supportsAction: ({ action }) => action === "sendAttachment",
      handleAction: async ({ params }) =>
        jsonResult({
          ok: true,
          buffer: params.buffer,
          filename: params.filename,
          caption: params.caption,
          contentType: params.contentType,
        }),
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "bluebubbles",
          source: "test",
          plugin: attachmentPlugin,
        },
      ]),
    );
    vi.mocked(loadWebMedia).mockResolvedValue({
      buffer: Buffer.from("hello"),
      contentType: "image/png",
      kind: "image",
      fileName: "pic.png",
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("hydrates buffer and filename from media for sendAttachment", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as ClawdbotConfig;

    const result = await runMessageAction({
      cfg,
      action: "sendAttachment",
      params: {
        channel: "bluebubbles",
        target: "+15551234567",
        media: "https://example.com/pic.png",
        message: "caption",
      },
    });

    expect(result.kind).toBe("action");
    expect(result.payload).toMatchObject({
      ok: true,
      filename: "pic.png",
      caption: "caption",
      contentType: "image/png",
    });
    expect((result.payload as { buffer?: string }).buffer).toBe(
      Buffer.from("hello").toString("base64"),
    );
  });
});

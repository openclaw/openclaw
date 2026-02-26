import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createIMessageTestPlugin } from "../../test-utils/imessage-test-plugin.js";
import { loadWebMedia } from "../../web/media.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { runMessageAction } from "./message-action-runner.js";

vi.mock("../../web/media.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/media.js")>("../../web/media.js");
  return {
    ...actual,
    loadWebMedia: vi.fn(actual.loadWebMedia),
  };
});

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const whatsappConfig = {
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

const runDryAction = (params: {
  cfg: OpenClawConfig;
  action: "send" | "thread-reply" | "broadcast";
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: params.action,
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    dryRun: true,
    abortSignal: params.abortSignal,
    sandboxRoot: params.sandboxRoot,
  });

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runDryAction({
    ...params,
    action: "send",
  });

async function expectSandboxMediaRewrite(params: {
  sandboxDir: string;
  media?: string;
  message?: string;
  expectedRelativePath: string;
}) {
  const result = await runDrySend({
    cfg: slackConfig,
    actionParams: {
      channel: "slack",
      target: "#C12345678",
      ...(params.media ? { media: params.media } : {}),
      ...(params.message ? { message: params.message } : {}),
    },
    sandboxRoot: params.sandboxDir,
  });

  expect(result.kind).toBe("send");
  if (result.kind !== "send") {
    throw new Error("expected send result");
  }
  expect(result.sendResult?.mediaUrl).toBe(
    path.join(params.sandboxDir, params.expectedRelativePath),
  );
}

function createAlwaysConfiguredPluginConfig(account: Record<string, unknown> = { enabled: true }) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
  };
}

let createPluginRuntime: typeof import("../../plugins/runtime/index.js").createPluginRuntime;
let setSlackRuntime: typeof import("../../../extensions/slack/src/runtime.js").setSlackRuntime;
let setTelegramRuntime: typeof import("../../../extensions/telegram/src/runtime.js").setTelegramRuntime;
let setWhatsAppRuntime: typeof import("../../../extensions/whatsapp/src/runtime.js").setWhatsAppRuntime;

function installChannelRuntimes(params?: { includeTelegram?: boolean; includeWhatsApp?: boolean }) {
  const runtime = createPluginRuntime();
  setSlackRuntime(runtime);
  if (params?.includeTelegram !== false) {
    setTelegramRuntime(runtime);
  }
  if (params?.includeWhatsApp !== false) {
    setWhatsAppRuntime(runtime);
  }
}

describe("runMessageAction context isolation", () => {
  beforeAll(async () => {
    ({ createPluginRuntime } = await import("../../plugins/runtime/index.js"));
    ({ setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js"));
    ({ setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js"));
    ({ setWhatsAppRuntime } = await import("../../../extensions/whatsapp/src/runtime.js"));
  });

  beforeEach(() => {
    installChannelRuntimes();
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

  it("allows send when target matches current channel", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("accepts legacy to parameter for send", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        to: "#C12345678",
        message: "hi",
      },
    });

    expect(result.kind).toBe("send");
  });

  it("defaults to current channel when target is omitted", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("allows media-only send when target matches current channel", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("blocks send when target differs from current channel", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "channel:C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    });

    expect(result.kind).toBe("send");
  });

  it("blocks thread-reply when channelId differs from current channel", async () => {
    const result = await runDryAction({
      cfg: slackConfig,
      action: "thread-reply",
      actionParams: {
        channel: "slack",
        target: "C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    });

    expect(result.kind).toBe("action");
  });

  it.each([
    {
      name: "whatsapp",
      channel: "whatsapp",
      target: "123@g.us",
      currentChannelId: "123@g.us",
    },
    {
      name: "imessage",
      channel: "imessage",
      target: "imessage:+15551234567",
      currentChannelId: "imessage:+15551234567",
    },
  ] as const)("allows $name send when target matches current context", async (testCase) => {
    const result = await runDrySend({
      cfg: whatsappConfig,
      actionParams: {
        channel: testCase.channel,
        target: testCase.target,
        message: "hi",
      },
      toolContext: { currentChannelId: testCase.currentChannelId },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "whatsapp",
      channel: "whatsapp",
      target: "456@g.us",
      currentChannelId: "123@g.us",
      currentChannelProvider: "whatsapp",
    },
    {
      name: "imessage",
      channel: "imessage",
      target: "imessage:+15551230000",
      currentChannelId: "imessage:+15551234567",
      currentChannelProvider: "imessage",
    },
  ] as const)("blocks $name send when target differs from current context", async (testCase) => {
    const result = await runDrySend({
      cfg: whatsappConfig,
      actionParams: {
        channel: testCase.channel,
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: testCase.currentChannelId,
        currentChannelProvider: testCase.currentChannelProvider,
      },
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
    } as OpenClawConfig;

    const result = await runDrySend({
      cfg: multiConfig,
      actionParams: {
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    });

    expect(result.kind).toBe("send");
    expect(result.channel).toBe("slack");
  });

  it("blocks cross-provider sends by default", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "telegram",
          target: "@opsbot",
          message: "hi",
        },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
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
    } as OpenClawConfig;

    await expect(
      runDrySend({
        cfg,
        actionParams: {
          channel: "slack",
          target: "channel:C99999999",
          message: "hi",
        },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
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

describe("runMessageAction sendAttachment hydration", () => {
  const cfg = {
    channels: {
      bluebubbles: {
        enabled: true,
        serverUrl: "http://localhost:1234",
        password: "test-password",
      },
    },
  } as OpenClawConfig;
  const attachmentPlugin: ChannelPlugin = {
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
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    actions: {
      listActions: () => ["sendAttachment", "setGroupIcon"],
      supportsAction: ({ action }) => action === "sendAttachment" || action === "setGroupIcon",
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

  async function restoreRealMediaLoader() {
    const actual = await vi.importActual<typeof import("../../web/media.js")>("../../web/media.js");
    vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);
  }

  async function expectRejectsLocalAbsolutePathWithoutSandbox(params: {
    action: "sendAttachment" | "setGroupIcon";
    target: string;
    message?: string;
    tempPrefix: string;
  }) {
    await restoreRealMediaLoader();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
    try {
      const outsidePath = path.join(tempDir, "secret.txt");
      await fs.writeFile(outsidePath, "secret", "utf8");

      const actionParams: Record<string, unknown> = {
        channel: "bluebubbles",
        target: params.target,
        media: outsidePath,
      };
      if (params.message) {
        actionParams.message = params.message;
      }

      await expect(
        runMessageAction({
          cfg,
          action: params.action,
          params: actionParams,
        }),
      ).rejects.toThrow(/allowed directory|path-not-allowed/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  it("hydrates buffer and filename from media for sendAttachment", async () => {
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
    const call = vi.mocked(loadWebMedia).mock.calls[0];
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        localRoots: expect.any(Array),
      }),
    );
    expect((call?.[1] as { sandboxValidated?: boolean } | undefined)?.sandboxValidated).not.toBe(
      true,
    );
  });

  it("rewrites sandboxed media paths for sendAttachment", async () => {
    await withSandbox(async (sandboxDir) => {
      await runMessageAction({
        cfg,
        action: "sendAttachment",
        params: {
          channel: "bluebubbles",
          target: "+15551234567",
          media: "./data/pic.png",
          message: "caption",
        },
        sandboxRoot: sandboxDir,
      });

      const call = vi.mocked(loadWebMedia).mock.calls[0];
      expect(call?.[0]).toBe(path.join(sandboxDir, "data", "pic.png"));
      expect(call?.[1]).toEqual(
        expect.objectContaining({
          sandboxValidated: true,
        }),
      );
    });
  });

  it("rejects local absolute path for sendAttachment when sandboxRoot is missing", async () => {
    await expectRejectsLocalAbsolutePathWithoutSandbox({
      action: "sendAttachment",
      target: "+15551234567",
      message: "caption",
      tempPrefix: "msg-attachment-",
    });
  });

  it("rejects local absolute path for setGroupIcon when sandboxRoot is missing", async () => {
    await expectRejectsLocalAbsolutePathWithoutSandbox({
      action: "setGroupIcon",
      target: "group:123",
      tempPrefix: "msg-group-icon-",
    });
  });
});

describe("runMessageAction sandboxed media validation", () => {
  beforeEach(() => {
    installChannelRuntimes({ includeTelegram: false, includeWhatsApp: false });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each(["/etc/passwd", "file:///etc/passwd"])(
    "rejects out-of-sandbox media reference: %s",
    async (media) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend({
            cfg: slackConfig,
            actionParams: {
              channel: "slack",
              target: "#C12345678",
              media,
              message: "",
            },
            sandboxRoot: sandboxDir,
          }),
        ).rejects.toThrow(/sandbox/i);
      });
    },
  );

  it("rejects data URLs in media params", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
          media: "data:image/png;base64,abcd",
          message: "",
        },
      }),
    ).rejects.toThrow(/data:/i);
  });

  it("rewrites sandbox-relative media paths", async () => {
    await withSandbox(async (sandboxDir) => {
      await expectSandboxMediaRewrite({
        sandboxDir,
        media: "./data/file.txt",
        message: "",
        expectedRelativePath: path.join("data", "file.txt"),
      });
    });
  });

  it("rewrites /workspace media paths to host sandbox root", async () => {
    await withSandbox(async (sandboxDir) => {
      await expectSandboxMediaRewrite({
        sandboxDir,
        media: "/workspace/data/file.txt",
        message: "",
        expectedRelativePath: path.join("data", "file.txt"),
      });
    });
  });

  it("rewrites MEDIA directives under sandbox", async () => {
    await withSandbox(async (sandboxDir) => {
      await expectSandboxMediaRewrite({
        sandboxDir,
        message: "Hello\nMEDIA: ./data/note.ogg",
        expectedRelativePath: path.join("data", "note.ogg"),
      });
    });
  });

  it("allows media paths under preferred OpenClaw tmp root", async () => {
    const tmpRoot = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(tmpRoot, { recursive: true });
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
    try {
      const tmpFile = path.join(tmpRoot, "test-media-image.png");
      const result = await runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          channel: "slack",
          target: "#C12345678",
          media: tmpFile,
          message: "",
        },
        sandboxRoot: sandboxDir,
        dryRun: true,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      // runMessageAction normalizes media paths through platform resolution.
      expect(result.sendResult?.mediaUrl).toBe(path.resolve(tmpFile));
      const hostTmpOutsideOpenClaw = path.join(os.tmpdir(), "outside-openclaw", "test-media.png");
      await expect(
        runMessageAction({
          cfg: slackConfig,
          action: "send",
          params: {
            channel: "slack",
            target: "#C12345678",
            media: hostTmpOutsideOpenClaw,
            message: "",
          },
          sandboxRoot: sandboxDir,
          dryRun: true,
        }),
      ).rejects.toThrow(/sandbox/i);
    } finally {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe("runMessageAction media caption behavior", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
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
  });
});

describe("runMessageAction card-only send behavior", () => {
  const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
    jsonResult({
      ok: true,
      card: params.card ?? null,
      message: params.message ?? null,
    }),
  );

  const cardPlugin: ChannelPlugin = {
    id: "cardchat",
    meta: {
      id: "cardchat",
      label: "Card Chat",
      selectionLabel: "Card Chat",
      docsPath: "/channels/cardchat",
      blurb: "Card-only send test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    actions: {
      listActions: () => ["send"],
      supportsAction: ({ action }) => action === "send",
      handleAction,
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "cardchat",
          source: "test",
          plugin: cardPlugin,
        },
      ]),
    );
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("allows card-only sends without text or media", async () => {
    const cfg = {
      channels: {
        cardchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const card = {
      type: "AdaptiveCard",
      version: "1.4",
      body: [{ type: "TextBlock", text: "Card-only payload" }],
    };

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "cardchat",
        target: "channel:test-card",
        card,
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("plugin");
    expect(handleAction).toHaveBeenCalled();
    expect(result.payload).toMatchObject({
      ok: true,
      card,
    });
  });
});

describe("runMessageAction components parsing", () => {
  const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
    jsonResult({
      ok: true,
      components: params.components ?? null,
    }),
  );

  const componentsPlugin: ChannelPlugin = {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord components send test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig({}),
    actions: {
      listActions: () => ["send"],
      supportsAction: ({ action }) => action === "send",
      handleAction,
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: componentsPlugin,
        },
      ]),
    );
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("parses components JSON strings before plugin dispatch", async () => {
    const components = {
      text: "hello",
      buttons: [{ label: "A", customId: "a" }],
    };
    const result = await runMessageAction({
      cfg: {} as OpenClawConfig,
      action: "send",
      params: {
        channel: "discord",
        target: "channel:123",
        message: "hi",
        components: JSON.stringify(components),
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(handleAction).toHaveBeenCalled();
    expect(result.payload).toMatchObject({ ok: true, components });
  });

  it("throws on invalid components JSON strings", async () => {
    await expect(
      runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "discord",
          target: "channel:123",
          message: "hi",
          components: "{not-json}",
        },
        dryRun: false,
      }),
    ).rejects.toThrow(/--components must be valid JSON/);

    expect(handleAction).not.toHaveBeenCalled();
  });
});

describe("runMessageAction accountId defaults", () => {
  const handleAction = vi.fn(async () => jsonResult({ ok: true }));
  const accountPlugin: ChannelPlugin = {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord test plugin.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    actions: {
      listActions: () => ["send"],
      handleAction,
    },
  };

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: accountPlugin,
        },
      ]),
    );
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("propagates defaultAccountId into params", async () => {
    await runMessageAction({
      cfg: {} as OpenClawConfig,
      action: "send",
      params: {
        channel: "discord",
        target: "channel:123",
        message: "hi",
      },
      defaultAccountId: "ops",
    });

    expect(handleAction).toHaveBeenCalled();
    const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
      | {
          accountId?: string | null;
          params: Record<string, unknown>;
        }
      | undefined;
    if (!ctx) {
      throw new Error("expected action context");
    }
    expect(ctx.accountId).toBe("ops");
    expect(ctx.params.accountId).toBe("ops");
  });

  it("falls back to the agent's bound account when accountId is omitted", async () => {
    await runMessageAction({
      cfg: {
        bindings: [{ agentId: "agent-b", match: { channel: "discord", accountId: "account-b" } }],
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "discord",
        target: "channel:123",
        message: "hi",
      },
      agentId: "agent-b",
    });

    expect(handleAction).toHaveBeenCalled();
    const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
      | {
          accountId?: string | null;
          params: Record<string, unknown>;
        }
      | undefined;
    if (!ctx) {
      throw new Error("expected action context");
    }
    expect(ctx.accountId).toBe("account-b");
    expect(ctx.params.accountId).toBe("account-b");
  });
});

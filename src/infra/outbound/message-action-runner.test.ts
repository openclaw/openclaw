import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createIMessageTestPlugin } from "../../test-utils/imessage-test-plugin.js";
import { runMessageAction } from "./message-action-runner.js";

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

  it("rejects send actions that include poll creation params", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
          message: "hi",
          pollQuestion: "Ready?",
          pollOption: ["Yes", "No"],
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("rejects send actions that include string-encoded poll params", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
          message: "hi",
          pollDurationSeconds: "60",
          pollPublic: "true",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("rejects send actions that include snake_case poll params", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
          message: "hi",
          poll_question: "Ready?",
          poll_option: ["Yes", "No"],
          poll_public: "true",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });

  it("allows send when poll booleans are explicitly false", async () => {
    const result = await runDrySend({
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
    });

    expect(result.kind).toBe("send");
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

  it("falls back to tool-context provider when channel param is an id", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "C12345678",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
    });

    expect(result.kind).toBe("send");
    expect(result.channel).toBe("slack");
  });

  it("falls back to tool-context provider for broadcast channel ids", async () => {
    const result = await runDryAction({
      cfg: slackConfig,
      action: "broadcast",
      actionParams: {
        targets: ["channel:C12345678"],
        channel: "C12345678",
        message: "hi",
      },
      toolContext: { currentChannelProvider: "slack" },
    });

    expect(result.kind).toBe("broadcast");
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

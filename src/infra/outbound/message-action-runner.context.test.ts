import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelDirectoryEntryKind,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
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
  action: ChannelMessageActionName;
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

type ResolvedTestTarget = { to: string; kind: ChannelDirectoryEntryKind };

const directOutbound: ChannelOutboundAdapter = { deliveryMode: "direct" };

function normalizeSlackTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  if (/^channel:/i.test(trimmed)) {
    return trimmed.replace(/^channel:/i, "").trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.replace(/^user:/i, "").trim();
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return trimmed;
}

function createConfiguredTestPlugin(params: {
  id: "slack" | "telegram" | "whatsapp";
  isConfigured: (cfg: OpenClawConfig) => boolean;
  normalizeTarget: (raw: string) => string | undefined;
  resolveTarget: (input: string) => ResolvedTestTarget | null;
}): ChannelPlugin {
  const messaging: ChannelMessagingAdapter = {
    normalizeTarget: params.normalizeTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(params.resolveTarget(raw.trim())),
      hint: "<id>",
      resolveTarget: async (resolverParams) => {
        const resolved = params.resolveTarget(resolverParams.input);
        return resolved ? { ...resolved, source: "normalized" } : null;
      },
    },
    inferTargetChatType: (inferParams) =>
      params.resolveTarget(inferParams.to)?.kind === "user" ? "direct" : "group",
  };
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: (_account, cfg) => params.isConfigured(cfg),
      },
    }),
    outbound: directOutbound,
    messaging,
  };
}

const slackTestPlugin = createConfiguredTestPlugin({
  id: "slack",
  isConfigured: (cfg) => Boolean(cfg.channels?.slack?.botToken?.trim()),
  normalizeTarget: (raw) => normalizeSlackTarget(raw) || undefined,
  resolveTarget: (input) => {
    const normalized = normalizeSlackTarget(input);
    if (!normalized) {
      return null;
    }
    if (/^[A-Z0-9]+$/i.test(normalized)) {
      const kind = /^U/i.test(normalized) ? "user" : "group";
      return { to: normalized, kind };
    }
    return null;
  },
});

const telegramTestPlugin = createConfiguredTestPlugin({
  id: "telegram",
  isConfigured: (cfg) => Boolean(cfg.channels?.telegram?.botToken?.trim()),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized.replace(/^telegram:/i, ""),
      kind: normalized.startsWith("@") ? "user" : "group",
    };
  },
});

const whatsappTestPlugin = createConfiguredTestPlugin({
  id: "whatsapp",
  isConfigured: (cfg) => Boolean(cfg.channels?.whatsapp),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized,
      kind: normalized.endsWith("@g.us") ? "group" : "user",
    };
  },
});

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

import { vi } from "vitest";
import { jsonResult, textResult } from "../../agents/tools/common.js";
import type {
  ChannelDirectoryEntryKind,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

type RunMessageAction = typeof import("./message-action-runner.js").runMessageAction;

const runFixtureMessageAction: RunMessageAction = async (...args) =>
  (await import("./message-action-runner.js")).runMessageAction(...args);

export const workspaceConfig = {
  channels: { workspace: { botToken: "workspace-test", appToken: "workspace-app-test" } },
} as OpenClawConfig;

export const directChatConfig = {
  channels: { directchat: { allowFrom: ["*"] } },
} as OpenClawConfig;

export const directOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "test", messageId: "test" }),
};

function registerPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
}

export function registerSlackTextPlugin(
  accountIds: string[] = ["default"],
  defaultAccountId?: string,
  deliveryMode: "direct" | "gateway" = "direct",
  messaging?: ChannelPlugin["messaging"],
) {
  const sendText = vi.fn().mockResolvedValue({ channel: "slack", messageId: "m1", chatId: "C123" });
  registerPlugins({
    ...createChannelTestPluginBase({
      id: "slack",
      config: {
        listAccountIds: () => accountIds,
        ...(defaultAccountId ? { defaultAccountId: () => defaultAccountId } : {}),
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    outbound: { deliveryMode, sendText },
    threading: { threadAddressing: "message" },
    ...(messaging ? { messaging } : {}),
  });
  return sendText;
}

export function createMessageActionContextFixture() {
  const handleWorkspaceAction = vi.fn(successfulAction);
  const handleForumAction = vi.fn(successfulAction);
  const localChatBase = createChannelTestPluginBase({
    id: "localchat",
    label: "Local Chat",
    capabilities: { chatTypes: ["direct", "group"], media: true },
  });
  const localChatTestPlugin: ChannelPlugin = {
    ...localChatBase,
    meta: {
      ...localChatBase.meta,
      selectionLabel: "Local Chat (local)",
      blurb: "Local chat test stub.",
      aliases: ["local"],
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
  const resolvedDmTestPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "slackdm",
      label: "Resolved DM",
      capabilities: { chatTypes: ["direct"], media: true },
    }),
    outbound: directOutbound,
    messaging: {
      normalizeTarget: (raw) => {
        const trimmed = raw.trim();
        const prefix = /^user:/i.test(trimmed) ? "user" : "channel";
        return trimmed ? `${prefix}:${trimmed.replace(/^user:/i, "").toLowerCase()}` : undefined;
      },
      targetResolver: {
        looksLikeId: (raw) => /^(?:user:)?[UW][A-Z0-9]+$/i.test(raw.trim()),
        hint: "<user:ID>",
        resolveTarget: async ({ input }) => {
          const userId = input.trim().replace(/^user:/i, "");
          return /^[UW][A-Z0-9]+$/i.test(userId)
            ? { to: userId, kind: "user", source: "normalized" }
            : null;
        },
      },
    },
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) =>
        target.toLowerCase() ===
        toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
    },
  };
  return {
    handleWorkspaceAction,
    handleForumAction,
    setup(): void {
      registerPlugins(
        withActions(workspaceTestPlugin, ["read"], handleWorkspaceAction),
        directChatTestPlugin,
        withActions(forumTestPlugin, ["topic-create", "topic-edit"], handleForumAction),
        localChatTestPlugin,
        resolvedDmTestPlugin,
      );
      handleWorkspaceAction.mockClear();
      handleForumAction.mockClear();
    },
    cleanup(): void {
      registerPlugins();
    },
  };
}

async function successfulAction(_ctx: ChannelMessageActionContext) {
  return jsonResult({ ok: true });
}

function withActions(
  plugin: ChannelPlugin,
  actions: ChannelMessageActionName[],
  handleAction: ChannelActionHandler,
): ChannelPlugin {
  return { ...plugin, actions: { describeMessageTool: () => ({ actions }), handleAction } };
}

export const runDryAction = ({
  actionParams,
  toolContext,
  ...options
}: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
  agentId?: string;
}) =>
  runFixtureMessageAction({
    ...options,
    params: actionParams as never,
    toolContext: toolContext as never,
    dryRun: true,
  });

export const runDrySend = (params: Omit<Parameters<typeof runDryAction>[0], "action">) =>
  runDryAction({ ...params, action: "send" });

type ResolvedTestTarget = { to: string; kind: ChannelDirectoryEntryKind };

function normalizeWorkspaceTarget(raw: string): string {
  const trimmed = raw.trim();
  if (/^(#|channel:|user:)/i.test(trimmed)) {
    return trimmed.replace(/^(#|channel:|user:)/i, "").trim();
  }
  return trimmed.match(/^<@([A-Z0-9]+)>$/i)?.[1] ?? trimmed;
}

// Test plugins model token-gated workspace sends without booting real channel runtimes.
function hasChannelBotToken(channelConfig: unknown): boolean {
  if (channelConfig == null || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return false;
  }
  const token = (channelConfig as Record<string, unknown>).botToken;
  return typeof token === "string" && Boolean(token.trim());
}

function createConfiguredTestPlugin(params: {
  id: string;
  isConfigured: (cfg: OpenClawConfig) => boolean;
  normalizeTarget?: (raw: string) => string | undefined;
  resolveTarget: (input: string) => ResolvedTestTarget | null;
}): ChannelPlugin {
  const normalizeTarget = params.normalizeTarget ?? ((raw: string) => raw.trim() || undefined);
  const resolveTarget = (raw: string) => {
    const normalized = normalizeTarget(raw);
    return normalized ? params.resolveTarget(normalized) : null;
  };
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      config: {
        resolveAccount: () => ({ enabled: true }),
        isConfigured: (_account, cfg) => params.isConfigured(cfg),
      },
    }),
    outbound: directOutbound,
    messaging: {
      normalizeTarget,
      targetResolver: {
        looksLikeId: (raw) => Boolean(resolveTarget(raw)),
        hint: "<id>",
        resolveTarget: async (resolverParams) => {
          const resolved = resolveTarget(resolverParams.input);
          return resolved ? { ...resolved, source: "normalized" } : null;
        },
      },
      inferTargetChatType: (inferParams) =>
        resolveTarget(inferParams.to)?.kind === "user" ? "direct" : "group",
    },
  };
}

export const workspaceTestPlugin = createConfiguredTestPlugin({
  id: "workspace",
  isConfigured: (cfg) => hasChannelBotToken(cfg.channels?.workspace),
  normalizeTarget: (raw) => normalizeWorkspaceTarget(raw) || undefined,
  resolveTarget: (normalized) =>
    /^[A-Z0-9]+$/i.test(normalized)
      ? { to: normalized, kind: /^U/i.test(normalized) ? "user" : "group" }
      : null,
});

export const forumTestPlugin = createConfiguredTestPlugin({
  id: "forum",
  isConfigured: (cfg) => hasChannelBotToken(cfg.channels?.forum),
  resolveTarget: (normalized) => ({
    to: normalized.replace(/^forum:/i, ""),
    kind: normalized.startsWith("@") ? "user" : "group",
  }),
});

export const directChatTestPlugin = createConfiguredTestPlugin({
  id: "directchat",
  isConfigured: (cfg) => Boolean(cfg.channels?.directchat),
  resolveTarget: (normalized) => ({
    to: normalized,
    kind: normalized.endsWith("@g.us") ? "group" : "user",
  }),
});

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

export function registerReplyPlugin() {
  const payload = { ok: true, messageId: "m-reply-1", repliedTo: "platform-guid-1" };
  const handleAction = vi.fn(async () => textResult(JSON.stringify(payload), payload));
  const base = createChannelTestPluginBase({
    id: "testchat",
    label: "Test Chat",
    config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
  });
  registerPlugins({
    ...base,
    meta: { ...base.meta, blurb: "Reply action test plugin." },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "testchat", messageId: "m-send-1" }),
    },
    messaging: { targetResolver: { looksLikeId: () => true } },
    actions: {
      describeMessageTool: () => ({ actions: ["reply", "poll"] }),
      supportsAction: ({ action }) => action === "reply" || action === "poll",
      handleAction,
    },
  });
  return handleAction;
}

export async function runReplyAction(params: {
  actionParams: Record<string, unknown>;
  currentMessageId?: string | number;
}) {
  return runCurrentConversationAction("reply", params.actionParams, params.currentMessageId);
}

export async function runCurrentConversationPollAction(params: { to: string }) {
  return runCurrentConversationAction(
    "poll",
    {
      to: params.to,
      pollQuestion: "Preferred default?",
      pollOption: ["Tell me right away", "Only important"],
    },
    "1783",
  );
}

function runCurrentConversationAction(
  action: "reply" | "poll",
  params: Record<string, unknown>,
  currentMessageId?: string | number,
) {
  const toolContext = {
    currentChannelProvider: "testchat" as const,
    currentChannelId: "direct:user-1",
    ...(currentMessageId !== undefined ? { currentMessageId } : {}),
  };
  return runFixtureMessageAction({
    cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
    action,
    params: { channel: "testchat", ...params },
    toolContext,
    messageActionAuthorization: { requesterAccountId: "default", toolContext },
    sessionKey: "agent:main:testchat:direct:user-1",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
  });
}

export function createPinboardMessageActionBootstrapRegistryMock() {
  const resolveIMessageTarget = ({ args }: { args: Record<string, unknown> }) => {
    if (typeof args.chatGuid === "string") {
      return `chat_guid:${args.chatGuid}`;
    }
    if (typeof args.chatId === "number" || typeof args.chatId === "string") {
      return `chat_id:${args.chatId}`;
    }
    return typeof args.chatIdentifier === "string"
      ? `chat_identifier:${args.chatIdentifier}`
      : undefined;
  };
  const deliveryAliases = (targetAlias: string) => ({
    aliases: ["chatGuid", "chatIdentifier", "chatId", targetAlias],
    deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
    resolveDeliveryTarget: resolveIMessageTarget,
  });
  return (channel: string) => {
    const messageActionTargetAliases =
      channel === "pinboard"
        ? {
            read: { aliases: ["messageId"] },
            pin: { aliases: ["messageId"] },
            unpin: { aliases: ["messageId"] },
            "list-pins": { aliases: ["chatId"] },
            "channel-info": { aliases: ["chatId"] },
          }
        : channel === "imessage"
          ? {
              react: deliveryAliases("messageId"),
              unsend: deliveryAliases("messageId"),
              "upload-file": { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
              "poll-vote": {
                ...deliveryAliases("pollId"),
                aliases: ["chatGuid", "chatIdentifier", "chatId", "pollId", "messageId"],
              },
            }
          : undefined;
    return messageActionTargetAliases ? { actions: { messageActionTargetAliases } } : undefined;
  };
}

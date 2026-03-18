/**
 * Runtime helpers for native channel plugins.
 *
 * This surface exposes core and channel-specific helpers used by bundled
 * plugins. Prefer hooks unless you need tight in-process coupling with the
 * OpenClaw messaging/runtime stack.
 */
type ReadChannelAllowFromStore =
  typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
type UpsertChannelPairingRequest =
  typeof import("../../pairing/pairing-store.js").upsertChannelPairingRequest;

type ReadChannelAllowFromStoreForAccount = (params: {
  channel: Parameters<ReadChannelAllowFromStore>[0];
  accountId: string;
  env?: Parameters<ReadChannelAllowFromStore>[1];
}) => ReturnType<ReadChannelAllowFromStore>;

type UpsertChannelPairingRequestForAccount = (
  params: Omit<Parameters<UpsertChannelPairingRequest>[0], "accountId"> & { accountId: string },
) => ReturnType<UpsertChannelPairingRequest>;

export type PluginRuntimeChannel = {
  text: {
    chunkByNewline: typeof import("../../auto-reply/chunk.js").chunkByNewline;
    chunkMarkdownText: typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
    chunkMarkdownTextWithMode: typeof import("../../auto-reply/chunk.js").chunkMarkdownTextWithMode;
    chunkText: typeof import("../../auto-reply/chunk.js").chunkText;
    chunkTextWithMode: typeof import("../../auto-reply/chunk.js").chunkTextWithMode;
    resolveChunkMode: typeof import("../../auto-reply/chunk.js").resolveChunkMode;
    resolveTextChunkLimit: typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
    hasControlCommand: typeof import("../../auto-reply/command-detection.js").hasControlCommand;
    resolveMarkdownTableMode: typeof import("../../config/markdown-tables.js").resolveMarkdownTableMode;
    convertMarkdownTables: typeof import("../../markdown/tables.js").convertMarkdownTables;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
    createReplyDispatcherWithTyping: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
    resolveEffectiveMessagesConfig: typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
    resolveHumanDelayConfig: typeof import("../../agents/identity.js").resolveHumanDelayConfig;
    dispatchReplyFromConfig: typeof import("../../auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
    withReplyDispatcher: typeof import("../../auto-reply/dispatch.js").withReplyDispatcher;
    finalizeInboundContext: typeof import("../../auto-reply/reply/inbound-context.js").finalizeInboundContext;
    formatAgentEnvelope: typeof import("../../auto-reply/envelope.js").formatAgentEnvelope;
    /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
    formatInboundEnvelope: typeof import("../../auto-reply/envelope.js").formatInboundEnvelope;
    resolveEnvelopeFormatOptions: typeof import("../../auto-reply/envelope.js").resolveEnvelopeFormatOptions;
  };
  routing: {
    buildAgentSessionKey: typeof import("../../routing/resolve-route.js").buildAgentSessionKey;
    resolveAgentRoute: typeof import("../../routing/resolve-route.js").resolveAgentRoute;
  };
  pairing: {
    buildPairingReply: typeof import("../../pairing/pairing-messages.js").buildPairingReply;
    readAllowFromStore: ReadChannelAllowFromStoreForAccount;
    upsertPairingRequest: UpsertChannelPairingRequestForAccount;
  };
  media: {
    fetchRemoteMedia: typeof import("../../media/fetch.js").fetchRemoteMedia;
    saveMediaBuffer: typeof import("../../media/store.js").saveMediaBuffer;
  };
  activity: {
    record: typeof import("../../infra/channel-activity.js").recordChannelActivity;
    get: typeof import("../../infra/channel-activity.js").getChannelActivity;
  };
  session: {
    resolveStorePath: typeof import("../../config/sessions.js").resolveStorePath;
    readSessionUpdatedAt: typeof import("../../config/sessions.js").readSessionUpdatedAt;
    recordSessionMetaFromInbound: typeof import("../../config/sessions.js").recordSessionMetaFromInbound;
    recordInboundSession: typeof import("../../channels/session.js").recordInboundSession;
    updateLastRoute: typeof import("../../config/sessions.js").updateLastRoute;
  };
  mentions: {
    buildMentionRegexes: typeof import("../../auto-reply/reply/mentions.js").buildMentionRegexes;
    matchesMentionPatterns: typeof import("../../auto-reply/reply/mentions.js").matchesMentionPatterns;
    matchesMentionWithExplicit: typeof import("../../auto-reply/reply/mentions.js").matchesMentionWithExplicit;
  };
  reactions: {
    shouldAckReaction: typeof import("../../channels/ack-reactions.js").shouldAckReaction;
    removeAckReactionAfterReply: typeof import("../../channels/ack-reactions.js").removeAckReactionAfterReply;
  };
  groups: {
    resolveGroupPolicy: typeof import("../../config/group-policy.js").resolveChannelGroupPolicy;
    resolveRequireMention: typeof import("../../config/group-policy.js").resolveChannelGroupRequireMention;
  };
  debounce: {
    createInboundDebouncer: typeof import("../../auto-reply/inbound-debounce.js").createInboundDebouncer;
    resolveInboundDebounceMs: typeof import("../../auto-reply/inbound-debounce.js").resolveInboundDebounceMs;
  };
  commands: {
    resolveCommandAuthorizedFromAuthorizers: typeof import("../../channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
    isControlCommandMessage: typeof import("../../auto-reply/command-detection.js").isControlCommandMessage;
    shouldComputeCommandAuthorized: typeof import("../../auto-reply/command-detection.js").shouldComputeCommandAuthorized;
    shouldHandleTextCommands: typeof import("../../auto-reply/commands-registry.js").shouldHandleTextCommands;
  };
  discord: {
    messageActions: typeof import("../../../extensions/discord/runtime-api.js").discordMessageActions;
    auditChannelPermissions: typeof import("../../../extensions/discord/runtime-api.js").auditDiscordChannelPermissions;
    listDirectoryGroupsLive: typeof import("../../../extensions/discord/runtime-api.js").listDiscordDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../../extensions/discord/runtime-api.js").listDiscordDirectoryPeersLive;
    probeDiscord: typeof import("../../../extensions/discord/runtime-api.js").probeDiscord;
    resolveChannelAllowlist: typeof import("../../../extensions/discord/runtime-api.js").resolveDiscordChannelAllowlist;
    resolveUserAllowlist: typeof import("../../../extensions/discord/runtime-api.js").resolveDiscordUserAllowlist;
    sendComponentMessage: typeof import("../../../extensions/discord/runtime-api.js").sendDiscordComponentMessage;
    sendMessageDiscord: typeof import("../../../extensions/discord/runtime-api.js").sendMessageDiscord;
    sendPollDiscord: typeof import("../../../extensions/discord/runtime-api.js").sendPollDiscord;
    monitorDiscordProvider: typeof import("../../../extensions/discord/runtime-api.js").monitorDiscordProvider;
    threadBindings: {
      getManager: typeof import("../../../extensions/discord/runtime-api.js").getThreadBindingManager;
      resolveIdleTimeoutMs: typeof import("../../../extensions/discord/runtime-api.js").resolveThreadBindingIdleTimeoutMs;
      resolveInactivityExpiresAt: typeof import("../../../extensions/discord/runtime-api.js").resolveThreadBindingInactivityExpiresAt;
      resolveMaxAgeMs: typeof import("../../../extensions/discord/runtime-api.js").resolveThreadBindingMaxAgeMs;
      resolveMaxAgeExpiresAt: typeof import("../../../extensions/discord/runtime-api.js").resolveThreadBindingMaxAgeExpiresAt;
      setIdleTimeoutBySessionKey: typeof import("../../../extensions/discord/runtime-api.js").setThreadBindingIdleTimeoutBySessionKey;
      setMaxAgeBySessionKey: typeof import("../../../extensions/discord/runtime-api.js").setThreadBindingMaxAgeBySessionKey;
      unbindBySessionKey: typeof import("../../../extensions/discord/runtime-api.js").unbindThreadBindingsBySessionKey;
    };
    typing: {
      pulse: typeof import("../../../extensions/discord/runtime-api.js").sendTypingDiscord;
      start: (params: {
        channelId: string;
        accountId?: string;
        cfg?: ReturnType<typeof import("../../config/config.js").loadConfig>;
        intervalMs?: number;
      }) => Promise<{
        refresh: () => Promise<void>;
        stop: () => void;
      }>;
    };
    conversationActions: {
      editMessage: typeof import("../../../extensions/discord/runtime-api.js").editMessageDiscord;
      deleteMessage: typeof import("../../../extensions/discord/runtime-api.js").deleteMessageDiscord;
      pinMessage: typeof import("../../../extensions/discord/runtime-api.js").pinMessageDiscord;
      unpinMessage: typeof import("../../../extensions/discord/runtime-api.js").unpinMessageDiscord;
      createThread: typeof import("../../../extensions/discord/runtime-api.js").createThreadDiscord;
      editChannel: typeof import("../../../extensions/discord/runtime-api.js").editChannelDiscord;
    };
  };
  slack: {
    listDirectoryGroupsLive: typeof import("../../../extensions/slack/runtime-api.js").listSlackDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../../extensions/slack/runtime-api.js").listSlackDirectoryPeersLive;
    probeSlack: typeof import("../../../extensions/slack/runtime-api.js").probeSlack;
    resolveChannelAllowlist: typeof import("../../../extensions/slack/runtime-api.js").resolveSlackChannelAllowlist;
    resolveUserAllowlist: typeof import("../../../extensions/slack/runtime-api.js").resolveSlackUserAllowlist;
    sendMessageSlack: typeof import("../../../extensions/slack/runtime-api.js").sendMessageSlack;
    monitorSlackProvider: typeof import("../../../extensions/slack/runtime-api.js").monitorSlackProvider;
    handleSlackAction: typeof import("../../../extensions/slack/runtime-api.js").handleSlackAction;
  };
  telegram: {
    auditGroupMembership: typeof import("../../../extensions/telegram/runtime-api.js").auditTelegramGroupMembership;
    collectUnmentionedGroupIds: typeof import("../../../extensions/telegram/runtime-api.js").collectTelegramUnmentionedGroupIds;
    probeTelegram: typeof import("../../../extensions/telegram/runtime-api.js").probeTelegram;
    resolveTelegramToken: typeof import("../../../extensions/telegram/runtime-api.js").resolveTelegramToken;
    sendMessageTelegram: typeof import("../../../extensions/telegram/runtime-api.js").sendMessageTelegram;
    sendPollTelegram: typeof import("../../../extensions/telegram/runtime-api.js").sendPollTelegram;
    monitorTelegramProvider: typeof import("../../../extensions/telegram/runtime-api.js").monitorTelegramProvider;
    messageActions: typeof import("../../../extensions/telegram/runtime-api.js").telegramMessageActions;
    threadBindings: {
      setIdleTimeoutBySessionKey: typeof import("../../../extensions/telegram/runtime-api.js").setTelegramThreadBindingIdleTimeoutBySessionKey;
      setMaxAgeBySessionKey: typeof import("../../../extensions/telegram/runtime-api.js").setTelegramThreadBindingMaxAgeBySessionKey;
    };
    typing: {
      pulse: typeof import("../../../extensions/telegram/runtime-api.js").sendTypingTelegram;
      start: (params: {
        to: string;
        accountId?: string;
        cfg?: ReturnType<typeof import("../../config/config.js").loadConfig>;
        intervalMs?: number;
        messageThreadId?: number;
      }) => Promise<{
        refresh: () => Promise<void>;
        stop: () => void;
      }>;
    };
    conversationActions: {
      editMessage: typeof import("../../../extensions/telegram/runtime-api.js").editMessageTelegram;
      editReplyMarkup: typeof import("../../../extensions/telegram/runtime-api.js").editMessageReplyMarkupTelegram;
      clearReplyMarkup: (
        chatIdInput: string | number,
        messageIdInput: string | number,
        opts?: {
          token?: string;
          accountId?: string;
          verbose?: boolean;
          api?: Partial<import("grammy").Bot["api"]>;
          retry?: import("../../infra/retry.js").RetryConfig;
          cfg?: ReturnType<typeof import("../../config/config.js").loadConfig>;
        },
      ) => Promise<{ ok: true; messageId: string; chatId: string }>;
      deleteMessage: typeof import("../../../extensions/telegram/runtime-api.js").deleteMessageTelegram;
      renameTopic: typeof import("../../../extensions/telegram/runtime-api.js").renameForumTopicTelegram;
      pinMessage: typeof import("../../../extensions/telegram/runtime-api.js").pinMessageTelegram;
      unpinMessage: typeof import("../../../extensions/telegram/runtime-api.js").unpinMessageTelegram;
    };
  };
  signal: {
    probeSignal: typeof import("../../../extensions/signal/runtime-api.js").probeSignal;
    sendMessageSignal: typeof import("../../../extensions/signal/runtime-api.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../../extensions/signal/runtime-api.js").monitorSignalProvider;
    messageActions: typeof import("../../channels/plugins/actions/signal.js").signalMessageActions;
  };
  imessage: {
    monitorIMessageProvider: typeof import("../../../extensions/imessage/runtime-api.js").monitorIMessageProvider;
    probeIMessage: typeof import("../../../extensions/imessage/runtime-api.js").probeIMessage;
    sendMessageIMessage: typeof import("../../../extensions/imessage/runtime-api.js").sendMessageIMessage;
  };
  whatsapp: {
    getActiveWebListener: typeof import("../../../extensions/whatsapp/runtime-api.js").getActiveWebListener;
    getWebAuthAgeMs: typeof import("../../../extensions/whatsapp/runtime-api.js").getWebAuthAgeMs;
    logoutWeb: typeof import("../../../extensions/whatsapp/runtime-api.js").logoutWeb;
    logWebSelfId: typeof import("../../../extensions/whatsapp/runtime-api.js").logWebSelfId;
    readWebSelfId: typeof import("../../../extensions/whatsapp/runtime-api.js").readWebSelfId;
    webAuthExists: typeof import("../../../extensions/whatsapp/runtime-api.js").webAuthExists;
    sendMessageWhatsApp: typeof import("../../../extensions/whatsapp/runtime-api.js").sendMessageWhatsApp;
    sendPollWhatsApp: typeof import("../../../extensions/whatsapp/runtime-api.js").sendPollWhatsApp;
    loginWeb: typeof import("../../../extensions/whatsapp/runtime-api.js").loginWeb;
    startWebLoginWithQr: typeof import("../../../extensions/whatsapp/login-qr-api.js").startWebLoginWithQr;
    waitForWebLogin: typeof import("../../../extensions/whatsapp/login-qr-api.js").waitForWebLogin;
    monitorWebChannel: typeof import("../../channels/web/index.js").monitorWebChannel;
    handleWhatsAppAction: typeof import("../../../extensions/whatsapp/action-runtime.runtime.js").handleWhatsAppAction;
    createLoginTool: typeof import("./runtime-whatsapp-login-tool.js").createRuntimeWhatsAppLoginTool;
  };
  line: {
    listLineAccountIds: typeof import("../../line/accounts.js").listLineAccountIds;
    resolveDefaultLineAccountId: typeof import("../../line/accounts.js").resolveDefaultLineAccountId;
    resolveLineAccount: typeof import("../../line/accounts.js").resolveLineAccount;
    normalizeAccountId: typeof import("../../line/accounts.js").normalizeAccountId;
    probeLineBot: typeof import("../../line/probe.js").probeLineBot;
    sendMessageLine: typeof import("../../line/send.js").sendMessageLine;
    pushMessageLine: typeof import("../../line/send.js").pushMessageLine;
    pushMessagesLine: typeof import("../../line/send.js").pushMessagesLine;
    pushFlexMessage: typeof import("../../line/send.js").pushFlexMessage;
    pushTemplateMessage: typeof import("../../line/send.js").pushTemplateMessage;
    pushLocationMessage: typeof import("../../line/send.js").pushLocationMessage;
    pushTextMessageWithQuickReplies: typeof import("../../line/send.js").pushTextMessageWithQuickReplies;
    createQuickReplyItems: typeof import("../../line/send.js").createQuickReplyItems;
    buildTemplateMessageFromPayload: typeof import("../../line/template-messages.js").buildTemplateMessageFromPayload;
    monitorLineProvider: typeof import("../../line/monitor.js").monitorLineProvider;
  };
};

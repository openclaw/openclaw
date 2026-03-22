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
    messageActions: typeof import("../../plugin-sdk/discord.js").discordMessageActions;
    auditChannelPermissions: typeof import("../../plugin-sdk/discord.js").auditDiscordChannelPermissions;
    listDirectoryGroupsLive: typeof import("../../plugin-sdk/discord.js").listDiscordDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../plugin-sdk/discord.js").listDiscordDirectoryPeersLive;
    probeDiscord: typeof import("../../plugin-sdk/discord.js").probeDiscord;
    resolveChannelAllowlist: typeof import("../../plugin-sdk/discord.js").resolveDiscordChannelAllowlist;
    resolveUserAllowlist: typeof import("../../plugin-sdk/discord.js").resolveDiscordUserAllowlist;
    sendComponentMessage: typeof import("../../plugin-sdk/discord.js").sendDiscordComponentMessage;
    sendMessageDiscord: typeof import("../../plugin-sdk/discord.js").sendMessageDiscord;
    sendPollDiscord: typeof import("../../plugin-sdk/discord.js").sendPollDiscord;
    monitorDiscordProvider: typeof import("../../plugin-sdk/discord.js").monitorDiscordProvider;
    threadBindings: {
      getManager: typeof import("../../plugin-sdk/discord.js").getThreadBindingManager;
      resolveIdleTimeoutMs: typeof import("../../plugin-sdk/discord.js").resolveThreadBindingIdleTimeoutMs;
      resolveInactivityExpiresAt: typeof import("../../plugin-sdk/discord.js").resolveThreadBindingInactivityExpiresAt;
      resolveMaxAgeMs: typeof import("../../plugin-sdk/discord.js").resolveThreadBindingMaxAgeMs;
      resolveMaxAgeExpiresAt: typeof import("../../plugin-sdk/discord.js").resolveThreadBindingMaxAgeExpiresAt;
      setIdleTimeoutBySessionKey: typeof import("../../plugin-sdk/discord.js").setThreadBindingIdleTimeoutBySessionKey;
      setMaxAgeBySessionKey: typeof import("../../plugin-sdk/discord.js").setThreadBindingMaxAgeBySessionKey;
      unbindBySessionKey: typeof import("../../plugin-sdk/discord.js").unbindThreadBindingsBySessionKey;
    };
    typing: {
      pulse: typeof import("../../plugin-sdk/discord.js").sendTypingDiscord;
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
      editMessage: typeof import("../../plugin-sdk/discord.js").editMessageDiscord;
      deleteMessage: typeof import("../../plugin-sdk/discord.js").deleteMessageDiscord;
      pinMessage: typeof import("../../plugin-sdk/discord.js").pinMessageDiscord;
      unpinMessage: typeof import("../../plugin-sdk/discord.js").unpinMessageDiscord;
      createThread: typeof import("../../plugin-sdk/discord.js").createThreadDiscord;
      editChannel: typeof import("../../plugin-sdk/discord.js").editChannelDiscord;
    };
  };
  slack: {
    listDirectoryGroupsLive: typeof import("../../plugin-sdk/slack.js").listSlackDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../plugin-sdk/slack.js").listSlackDirectoryPeersLive;
    probeSlack: typeof import("../../plugin-sdk/slack.js").probeSlack;
    resolveChannelAllowlist: typeof import("../../plugin-sdk/slack.js").resolveSlackChannelAllowlist;
    resolveUserAllowlist: typeof import("../../plugin-sdk/slack.js").resolveSlackUserAllowlist;
    sendMessageSlack: typeof import("../../plugin-sdk/slack.js").sendMessageSlack;
    monitorSlackProvider: typeof import("../../plugin-sdk/slack.js").monitorSlackProvider;
    handleSlackAction: typeof import("../../plugin-sdk/slack.js").handleSlackAction;
  };
  telegram: {
    auditGroupMembership: typeof import("../../plugin-sdk/telegram.js").auditTelegramGroupMembership;
    collectUnmentionedGroupIds: typeof import("../../plugin-sdk/telegram.js").collectTelegramUnmentionedGroupIds;
    probeTelegram: typeof import("../../plugin-sdk/telegram.js").probeTelegram;
    resolveTelegramToken: typeof import("../../plugin-sdk/telegram.js").resolveTelegramToken;
    sendMessageTelegram: typeof import("../../plugin-sdk/telegram.js").sendMessageTelegram;
    sendPollTelegram: typeof import("../../plugin-sdk/telegram.js").sendPollTelegram;
    monitorTelegramProvider: typeof import("../../plugin-sdk/telegram.js").monitorTelegramProvider;
    messageActions: typeof import("../../plugin-sdk/telegram.js").telegramMessageActions;
    threadBindings: {
      setIdleTimeoutBySessionKey: typeof import("../../plugin-sdk/telegram.js").setTelegramThreadBindingIdleTimeoutBySessionKey;
      setMaxAgeBySessionKey: typeof import("../../plugin-sdk/telegram.js").setTelegramThreadBindingMaxAgeBySessionKey;
    };
    typing: {
      pulse: typeof import("../../plugin-sdk/telegram.js").sendTypingTelegram;
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
      editMessage: typeof import("../../plugin-sdk/telegram.js").editMessageTelegram;
      editReplyMarkup: typeof import("../../plugin-sdk/telegram.js").editMessageReplyMarkupTelegram;
      clearReplyMarkup: (
        chatIdInput: string | number,
        messageIdInput: string | number,
        opts?: Parameters<
          typeof import("../../plugin-sdk/telegram.js").editMessageReplyMarkupTelegram
        >[3],
      ) => Promise<{ ok: true; messageId: string; chatId: string }>;
      deleteMessage: typeof import("../../plugin-sdk/telegram.js").deleteMessageTelegram;
      renameTopic: typeof import("../../plugin-sdk/telegram.js").renameForumTopicTelegram;
      pinMessage: typeof import("../../plugin-sdk/telegram.js").pinMessageTelegram;
      unpinMessage: typeof import("../../plugin-sdk/telegram.js").unpinMessageTelegram;
    };
  };
  matrix: {
    threadBindings: {
      setIdleTimeoutBySessionKey: typeof import("../../plugin-sdk/matrix.js").setMatrixThreadBindingIdleTimeoutBySessionKey;
      setMaxAgeBySessionKey: typeof import("../../plugin-sdk/matrix.js").setMatrixThreadBindingMaxAgeBySessionKey;
    };
  };
  signal: {
    probeSignal: typeof import("../../plugin-sdk/signal.js").probeSignal;
    sendMessageSignal: typeof import("../../plugin-sdk/signal.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../plugin-sdk/signal.js").monitorSignalProvider;
    messageActions: typeof import("../../plugin-sdk/signal.js").signalMessageActions;
  };
  imessage: {
    monitorIMessageProvider: typeof import("../../plugin-sdk/imessage.js").monitorIMessageProvider;
    probeIMessage: typeof import("../../plugin-sdk/imessage.js").probeIMessage;
    sendMessageIMessage: typeof import("../../plugin-sdk/imessage.js").sendMessageIMessage;
  };
  whatsapp: {
    getActiveWebListener: typeof import("./runtime-whatsapp-boundary.js").getActiveWebListener;
    getWebAuthAgeMs: typeof import("./runtime-whatsapp-boundary.js").getWebAuthAgeMs;
    logoutWeb: typeof import("./runtime-whatsapp-boundary.js").logoutWeb;
    logWebSelfId: typeof import("./runtime-whatsapp-boundary.js").logWebSelfId;
    readWebSelfId: typeof import("./runtime-whatsapp-boundary.js").readWebSelfId;
    webAuthExists: typeof import("./runtime-whatsapp-boundary.js").webAuthExists;
    sendMessageWhatsApp: typeof import("./runtime-whatsapp-boundary.js").sendMessageWhatsApp;
    sendPollWhatsApp: typeof import("./runtime-whatsapp-boundary.js").sendPollWhatsApp;
    loginWeb: typeof import("./runtime-whatsapp-boundary.js").loginWeb;
    startWebLoginWithQr: typeof import("./runtime-whatsapp-boundary.js").startWebLoginWithQr;
    waitForWebLogin: typeof import("./runtime-whatsapp-boundary.js").waitForWebLogin;
    monitorWebChannel: typeof import("./runtime-whatsapp-boundary.js").monitorWebChannel;
    handleWhatsAppAction: typeof import("./runtime-whatsapp-boundary.js").handleWhatsAppAction;
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

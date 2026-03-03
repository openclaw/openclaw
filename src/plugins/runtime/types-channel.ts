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
    messageActions: typeof import("../../channels/plugins/actions/discord.js").discordMessageActions;
    auditChannelPermissions: typeof import("../../discord/audit.js").auditDiscordChannelPermissions;
    listDirectoryGroupsLive: typeof import("../../discord/directory-live.js").listDiscordDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../discord/directory-live.js").listDiscordDirectoryPeersLive;
    probeDiscord: typeof import("../../discord/probe.js").probeDiscord;
    resolveChannelAllowlist: typeof import("../../discord/resolve-channels.js").resolveDiscordChannelAllowlist;
    resolveUserAllowlist: typeof import("../../discord/resolve-users.js").resolveDiscordUserAllowlist;
    sendMessageDiscord: typeof import("../../discord/send.js").sendMessageDiscord;
    sendPollDiscord: typeof import("../../discord/send.js").sendPollDiscord;
    monitorDiscordProvider: typeof import("../../discord/monitor.js").monitorDiscordProvider;
  };
  slack: {
    listDirectoryGroupsLive: typeof import("../../slack/directory-live.js").listSlackDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../slack/directory-live.js").listSlackDirectoryPeersLive;
    probeSlack: typeof import("../../slack/probe.js").probeSlack;
    resolveChannelAllowlist: typeof import("../../slack/resolve-channels.js").resolveSlackChannelAllowlist;
    resolveUserAllowlist: typeof import("../../slack/resolve-users.js").resolveSlackUserAllowlist;
    sendMessageSlack: typeof import("../../slack/send.js").sendMessageSlack;
    monitorSlackProvider: typeof import("../../slack/index.js").monitorSlackProvider;
    handleSlackAction: typeof import("../../agents/tools/slack-actions.js").handleSlackAction;
  };
  telegram: {
    auditGroupMembership: typeof import("../../telegram/audit.js").auditTelegramGroupMembership;
    collectUnmentionedGroupIds: typeof import("../../telegram/audit.js").collectTelegramUnmentionedGroupIds;
    probeTelegram: typeof import("../../telegram/probe.js").probeTelegram;
    resolveTelegramToken: typeof import("../../telegram/token.js").resolveTelegramToken;
    sendMessageTelegram: typeof import("../../telegram/send.js").sendMessageTelegram;
    sendPollTelegram: typeof import("../../telegram/send.js").sendPollTelegram;
    monitorTelegramProvider: typeof import("../../telegram/monitor.js").monitorTelegramProvider;
    messageActions: typeof import("../../channels/plugins/actions/telegram.js").telegramMessageActions;
  };
  signal: {
    probeSignal: typeof import("../../signal/probe.js").probeSignal;
    sendMessageSignal: typeof import("../../signal/send.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../signal/index.js").monitorSignalProvider;
    messageActions: typeof import("../../channels/plugins/actions/signal.js").signalMessageActions;
  };
  imessage: {
    monitorIMessageProvider: typeof import("../../imessage/monitor.js").monitorIMessageProvider;
    probeIMessage: typeof import("../../imessage/probe.js").probeIMessage;
    sendMessageIMessage: typeof import("../../imessage/send.js").sendMessageIMessage;
  };
  whatsapp: {
    getActiveWebListener: typeof import("../../web/active-listener.js").getActiveWebListener;
    getWebAuthAgeMs: typeof import("../../web/auth-store.js").getWebAuthAgeMs;
    logoutWeb: typeof import("../../web/auth-store.js").logoutWeb;
    logWebSelfId: typeof import("../../web/auth-store.js").logWebSelfId;
    readWebSelfId: typeof import("../../web/auth-store.js").readWebSelfId;
    webAuthExists: typeof import("../../web/auth-store.js").webAuthExists;
    sendMessageWhatsApp: typeof import("../../web/outbound.js").sendMessageWhatsApp;
    sendPollWhatsApp: typeof import("../../web/outbound.js").sendPollWhatsApp;
    loginWeb: typeof import("../../web/login.js").loginWeb;
    startWebLoginWithQr: typeof import("../../web/login-qr.js").startWebLoginWithQr;
    waitForWebLogin: typeof import("../../web/login-qr.js").waitForWebLogin;
    monitorWebChannel: typeof import("../../channels/web/index.js").monitorWebChannel;
    handleWhatsAppAction: typeof import("../../agents/tools/whatsapp-actions.js").handleWhatsAppAction;
    createLoginTool: typeof import("../../channels/plugins/agent-tools/whatsapp-login.js").createWhatsAppLoginTool;
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

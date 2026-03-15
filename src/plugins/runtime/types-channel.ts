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
    readRecentMessages: typeof import("../../config/sessions.js").readSessionRecentMessages;
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
    auditChannelPermissions: typeof import("../../../extensions/discord/src/audit.js").auditDiscordChannelPermissions;
    listDirectoryGroupsLive: typeof import("../../../extensions/discord/src/directory-live.js").listDiscordDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../../extensions/discord/src/directory-live.js").listDiscordDirectoryPeersLive;
    probeDiscord: typeof import("../../../extensions/discord/src/probe.js").probeDiscord;
    resolveChannelAllowlist: typeof import("../../../extensions/discord/src/resolve-channels.js").resolveDiscordChannelAllowlist;
    resolveUserAllowlist: typeof import("../../../extensions/discord/src/resolve-users.js").resolveDiscordUserAllowlist;
    sendMessageDiscord: typeof import("../../../extensions/discord/src/send.js").sendMessageDiscord;
    sendPollDiscord: typeof import("../../../extensions/discord/src/send.js").sendPollDiscord;
    monitorDiscordProvider: typeof import("../../../extensions/discord/src/monitor.js").monitorDiscordProvider;
  };
  slack: {
    listDirectoryGroupsLive: typeof import("../../../extensions/slack/src/directory-live.js").listSlackDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../../extensions/slack/src/directory-live.js").listSlackDirectoryPeersLive;
    probeSlack: typeof import("../../../extensions/slack/src/probe.js").probeSlack;
    resolveChannelAllowlist: typeof import("../../../extensions/slack/src/resolve-channels.js").resolveSlackChannelAllowlist;
    resolveUserAllowlist: typeof import("../../../extensions/slack/src/resolve-users.js").resolveSlackUserAllowlist;
    sendMessageSlack: typeof import("../../../extensions/slack/src/send.js").sendMessageSlack;
    monitorSlackProvider: typeof import("../../../extensions/slack/src/index.js").monitorSlackProvider;
    handleSlackAction: typeof import("../../agents/tools/slack-actions.js").handleSlackAction;
  };
  telegram: {
    auditGroupMembership: typeof import("../../../extensions/telegram/src/audit.js").auditTelegramGroupMembership;
    collectUnmentionedGroupIds: typeof import("../../../extensions/telegram/src/audit.js").collectTelegramUnmentionedGroupIds;
    probeTelegram: typeof import("../../../extensions/telegram/src/probe.js").probeTelegram;
    resolveTelegramToken: typeof import("../../../extensions/telegram/src/token.js").resolveTelegramToken;
    sendMessageTelegram: typeof import("../../../extensions/telegram/src/send.js").sendMessageTelegram;
    sendPollTelegram: typeof import("../../../extensions/telegram/src/send.js").sendPollTelegram;
    monitorTelegramProvider: typeof import("../../../extensions/telegram/src/monitor.js").monitorTelegramProvider;
    messageActions: typeof import("../../channels/plugins/actions/telegram.js").telegramMessageActions;
  };
  signal: {
    probeSignal: typeof import("../../../extensions/signal/src/probe.js").probeSignal;
    sendMessageSignal: typeof import("../../../extensions/signal/src/send.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../../extensions/signal/src/index.js").monitorSignalProvider;
    messageActions: typeof import("../../channels/plugins/actions/signal.js").signalMessageActions;
  };
  imessage: {
    monitorIMessageProvider: typeof import("../../../extensions/imessage/src/monitor.js").monitorIMessageProvider;
    probeIMessage: typeof import("../../../extensions/imessage/src/probe.js").probeIMessage;
    sendMessageIMessage: typeof import("../../../extensions/imessage/src/send.js").sendMessageIMessage;
  };
  whatsapp: {
    getActiveWebListener: typeof import("../../../extensions/whatsapp/src/active-listener.js").getActiveWebListener;
    getWebAuthAgeMs: typeof import("../../../extensions/whatsapp/src/auth-store.js").getWebAuthAgeMs;
    logoutWeb: typeof import("../../../extensions/whatsapp/src/auth-store.js").logoutWeb;
    logWebSelfId: typeof import("../../../extensions/whatsapp/src/auth-store.js").logWebSelfId;
    readWebSelfId: typeof import("../../../extensions/whatsapp/src/auth-store.js").readWebSelfId;
    webAuthExists: typeof import("../../../extensions/whatsapp/src/auth-store.js").webAuthExists;
    sendMessageWhatsApp: typeof import("../../../extensions/whatsapp/src/send.js").sendMessageWhatsApp;
    sendPollWhatsApp: typeof import("../../../extensions/whatsapp/src/send.js").sendPollWhatsApp;
    loginWeb: typeof import("../../../extensions/whatsapp/src/login.js").loginWeb;
    startWebLoginWithQr: typeof import("../../../extensions/whatsapp/src/login-qr.js").startWebLoginWithQr;
    waitForWebLogin: typeof import("../../../extensions/whatsapp/src/login-qr.js").waitForWebLogin;
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

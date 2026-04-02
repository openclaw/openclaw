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
type DiscordRuntimeSurface = typeof import("../../plugin-sdk/discord-runtime-surface.js");
type DiscordThreadBindings = typeof import("../../plugin-sdk/discord-thread-bindings.js");
type MatrixThreadBindings = typeof import("../../plugin-sdk/matrix-thread-bindings.js");

type ReadChannelAllowFromStoreForAccount = (params: {
  channel: Parameters<ReadChannelAllowFromStore>[0];
  accountId: string;
  env?: Parameters<ReadChannelAllowFromStore>[1];
}) => ReturnType<ReadChannelAllowFromStore>;

type UpsertChannelPairingRequestForAccount = (
  params: Omit<Parameters<UpsertChannelPairingRequest>[0], "accountId"> & { accountId: string },
) => ReturnType<UpsertChannelPairingRequest>;

export type RuntimeThreadBindingLifecycleRecord =
  | import("../../infra/outbound/session-binding-service.js").SessionBindingRecord
  | {
      boundAt: number;
      lastActivityAt: number;
      idleTimeoutMs?: number;
      maxAgeMs?: number;
    };

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
  outbound: {
    loadAdapter: typeof import("../../channels/plugins/outbound/load.js").loadChannelOutboundAdapter;
  };
  threadBindings: {
    setIdleTimeoutBySessionKey: (params: {
      channelId: "discord" | "matrix" | "telegram";
      targetSessionKey: string;
      accountId?: string;
      idleTimeoutMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
    setMaxAgeBySessionKey: (params: {
      channelId: "discord" | "matrix" | "telegram";
      targetSessionKey: string;
      accountId?: string;
      maxAgeMs: number;
    }) => RuntimeThreadBindingLifecycleRecord[];
  };
  discord: {
    messageActions: DiscordRuntimeSurface["discordMessageActions"];
    auditChannelPermissions: DiscordRuntimeSurface["auditDiscordChannelPermissions"];
    listDirectoryGroupsLive: DiscordRuntimeSurface["listDiscordDirectoryGroupsLive"];
    listDirectoryPeersLive: DiscordRuntimeSurface["listDiscordDirectoryPeersLive"];
    probeDiscord: DiscordRuntimeSurface["probeDiscord"];
    resolveChannelAllowlist: DiscordRuntimeSurface["resolveDiscordChannelAllowlist"];
    resolveUserAllowlist: DiscordRuntimeSurface["resolveDiscordUserAllowlist"];
    sendComponentMessage: DiscordRuntimeSurface["sendDiscordComponentMessage"];
    sendMessageDiscord: DiscordRuntimeSurface["sendMessageDiscord"];
    sendPollDiscord: DiscordRuntimeSurface["sendPollDiscord"];
    monitorDiscordProvider: DiscordRuntimeSurface["monitorDiscordProvider"];
    threadBindings: {
      getManager: DiscordThreadBindings["getThreadBindingManager"];
      resolveIdleTimeoutMs: DiscordThreadBindings["resolveThreadBindingIdleTimeoutMs"];
      resolveInactivityExpiresAt: DiscordThreadBindings["resolveThreadBindingInactivityExpiresAt"];
      resolveMaxAgeMs: DiscordThreadBindings["resolveThreadBindingMaxAgeMs"];
      resolveMaxAgeExpiresAt: DiscordThreadBindings["resolveThreadBindingMaxAgeExpiresAt"];
      setIdleTimeoutBySessionKey: DiscordThreadBindings["setThreadBindingIdleTimeoutBySessionKey"];
      setMaxAgeBySessionKey: DiscordThreadBindings["setThreadBindingMaxAgeBySessionKey"];
      unbindBySessionKey: DiscordThreadBindings["unbindThreadBindingsBySessionKey"];
    };
    typing: {
      pulse: DiscordRuntimeSurface["sendTypingDiscord"];
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
      editMessage: DiscordRuntimeSurface["editMessageDiscord"];
      deleteMessage: DiscordRuntimeSurface["deleteMessageDiscord"];
      pinMessage: DiscordRuntimeSurface["pinMessageDiscord"];
      unpinMessage: DiscordRuntimeSurface["unpinMessageDiscord"];
      createThread: DiscordRuntimeSurface["createThreadDiscord"];
      editChannel: DiscordRuntimeSurface["editChannelDiscord"];
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
  matrix: {
    threadBindings: {
      setIdleTimeoutBySessionKey: MatrixThreadBindings["setMatrixThreadBindingIdleTimeoutBySessionKey"];
      setMaxAgeBySessionKey: MatrixThreadBindings["setMatrixThreadBindingMaxAgeBySessionKey"];
    };
  };
  signal: {
    probeSignal: typeof import("../../plugin-sdk/signal.js").probeSignal;
    sendMessageSignal: typeof import("../../plugin-sdk/signal.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../plugin-sdk/signal.js").monitorSignalProvider;
    messageActions: typeof import("../../plugin-sdk/signal.js").signalMessageActions;
  };
  line: {
    listLineAccountIds: typeof import("../../plugin-sdk/line.js").listLineAccountIds;
    resolveDefaultLineAccountId: typeof import("../../plugin-sdk/line.js").resolveDefaultLineAccountId;
    resolveLineAccount: typeof import("../../plugin-sdk/line.js").resolveLineAccount;
    normalizeAccountId: typeof import("../../plugin-sdk/line.js").normalizeAccountId;
    probeLineBot: typeof import("../../plugin-sdk/line-runtime.js").probeLineBot;
    sendMessageLine: typeof import("../../plugin-sdk/line-runtime.js").sendMessageLine;
    pushMessageLine: typeof import("../../plugin-sdk/line-runtime.js").pushMessageLine;
    pushMessagesLine: typeof import("../../plugin-sdk/line-runtime.js").pushMessagesLine;
    pushFlexMessage: typeof import("../../plugin-sdk/line-runtime.js").pushFlexMessage;
    pushTemplateMessage: typeof import("../../plugin-sdk/line-runtime.js").pushTemplateMessage;
    pushLocationMessage: typeof import("../../plugin-sdk/line-runtime.js").pushLocationMessage;
    pushTextMessageWithQuickReplies: typeof import("../../plugin-sdk/line-runtime.js").pushTextMessageWithQuickReplies;
    createQuickReplyItems: typeof import("../../plugin-sdk/line-runtime.js").createQuickReplyItems;
    buildTemplateMessageFromPayload: typeof import("../../plugin-sdk/line-runtime.js").buildTemplateMessageFromPayload;
    monitorLineProvider: typeof import("../../plugin-sdk/line-runtime.js").monitorLineProvider;
  };
};

import type { LogLevel } from "../../logging/levels.js";

export type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginRuntime = {
  version: string;
  channel: {
    text: {
      chunkMarkdownText: typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
      resolveTextChunkLimit: typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
      hasControlCommand: typeof import("../../auto-reply/command-detection.js").hasControlCommand;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
      createReplyDispatcherWithTyping: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
      resolveEffectiveMessagesConfig: typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
      resolveHumanDelayConfig: typeof import("../../agents/identity.js").resolveHumanDelayConfig;
    };
    routing: {
      resolveAgentRoute: typeof import("../../routing/resolve-route.js").resolveAgentRoute;
    };
    pairing: {
      buildPairingReply: typeof import("../../pairing/pairing-messages.js").buildPairingReply;
      readAllowFromStore: typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
      upsertPairingRequest: typeof import("../../pairing/pairing-store.js").upsertChannelPairingRequest;
    };
    media: {
      fetchRemoteMedia: typeof import("../../media/fetch.js").fetchRemoteMedia;
      saveMediaBuffer: typeof import("../../media/store.js").saveMediaBuffer;
    };
    mentions: {
      buildMentionRegexes: typeof import("../../auto-reply/reply/mentions.js").buildMentionRegexes;
      matchesMentionPatterns: typeof import("../../auto-reply/reply/mentions.js").matchesMentionPatterns;
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
    };
  };
  logging: {
    shouldLogVerbose: typeof import("../../globals.js").shouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: typeof import("../../config/paths.js").resolveStateDir;
  };
};

import type { ClawdbotConfig } from "../../config/config.js";

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
      chunkMarkdownText: (text: string, limit: number) => string[];
      resolveTextChunkLimit: (cfg: ClawdbotConfig, channel: string, accountId?: string) => number;
      hasControlCommand: (text: string, cfg: ClawdbotConfig) => boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<void>;
      createReplyDispatcherWithTyping: (...args: unknown[]) => unknown;
      resolveEffectiveMessagesConfig: (
        cfg: ClawdbotConfig,
        agentId: string,
        opts?: { hasAllowFrom?: boolean; fallbackMessagePrefix?: string },
      ) => { messagePrefix: string; responsePrefix?: string };
      resolveHumanDelayConfig: (
        cfg: ClawdbotConfig,
        agentId: string,
      ) => { mode?: string; minMs?: number; maxMs?: number } | undefined;
    };
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }) => {
        agentId: string;
        channel: string;
        accountId: string;
        sessionKey: string;
        mainSessionKey: string;
        matchedBy: string;
      };
    };
    pairing: {
      buildPairingReply: (params: { channel: string; idLine: string; code: string }) => string;
      readAllowFromStore: (channel: string) => Promise<string[]>;
      upsertPairingRequest: (params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }) => Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia: (params: { url: string }) => Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer: (
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ) => Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes: (cfg: ClawdbotConfig, agentId?: string) => RegExp[];
      matchesMentionPatterns: (text: string, regexes: RegExp[]) => boolean;
    };
    groups: {
      resolveGroupPolicy: (
        cfg: ClawdbotConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ) => {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention: (
        cfg: ClawdbotConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ) => boolean;
    };
    debounce: {
      createInboundDebouncer: <T>(opts: {
        debounceMs: number;
        buildKey: (value: T) => string | null;
        shouldDebounce: (value: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }) => { push: (value: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs: (cfg: ClawdbotConfig, channel: string) => number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers: (params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }) => boolean;
    };
  };
  logging: {
    shouldLogVerbose: () => boolean;
    getChildLogger: (bindings?: Record<string, unknown>, opts?: { level?: string }) => RuntimeLogger;
  };
  state: {
    resolveStateDir: (cfg: ClawdbotConfig) => string;
  };
};

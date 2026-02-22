export type ThreadBindingTargetKind = "subagent" | "acp";

export type ThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: ThreadBindingTargetKind;
  targetSessionKey: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
  boundBy: string;
  boundAt: number;
  expiresAt?: number;
};

export type PersistedThreadBindingRecord = ThreadBindingRecord & {
  sessionKey?: string;
};

export type PersistedThreadBindingsPayload = {
  version: 1;
  bindings: Record<string, PersistedThreadBindingRecord>;
};

export type ThreadBindingManager = {
  accountId: string;
  getSessionTtlMs: () => number;
  getByThreadId: (threadId: string) => ThreadBindingRecord | undefined;
  getBySessionKey: (targetSessionKey: string) => ThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => ThreadBindingRecord[];
  listBindings: () => ThreadBindingRecord[];
  bindTarget: (params: {
    threadId?: string | number;
    channelId?: string;
    createThread?: boolean;
    threadName?: string;
    targetKind: ThreadBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    introText?: string;
    webhookId?: string;
    webhookToken?: string;
  }) => Promise<ThreadBindingRecord | null>;
  unbindThread: (params: {
    threadId: string;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord[];
  stop: () => void;
};

export const THREAD_BINDINGS_VERSION = 1 as const;
export const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000;
export const DEFAULT_THREAD_BINDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_FAREWELL_TEXT = "Session ended. Messages here will no longer be routed.";
export const DISCORD_UNKNOWN_CHANNEL_ERROR_CODE = 10_003;
export const RECENT_UNBOUND_WEBHOOK_ECHO_TTL_MS = 30_000;

// Transport types that determine OAG behavior
export type ChannelTransport = "websocket" | "polling" | "webhook" | "local";

// Transport-specific OAG defaults
export type TransportProfile = {
  transport: ChannelTransport;
  staleThresholdMs: number; // how long before "stale" detection
  recoveryBudgetMs: number; // time budget for delivery recovery
  maxRetries: number; // delivery retry attempts
  stalePollFactor: number; // multiplier for polling channels (1.0 for non-polling)
  restartBackoffInitialMs: number;
  restartBackoffMaxMs: number;
};

// Registry: channelId -> transport type
const CHANNEL_TRANSPORT_MAP: Record<string, ChannelTransport> = {
  // WebSocket channels
  discord: "websocket",
  slack: "websocket",
  whatsapp: "websocket",
  mattermost: "websocket",
  irc: "websocket",

  // Polling channels
  telegram: "polling",
  matrix: "polling",
  zalo: "polling",
  zalouser: "polling",
  "nextcloud-talk": "polling",
  tlon: "polling",
  nostr: "polling", // relay-based but uses polling pattern

  // Webhook channels (passive receivers)
  line: "webhook",
  googlechat: "webhook",
  msteams: "webhook",
  "synology-chat": "webhook",

  // Local process channels
  imessage: "local",
  bluebubbles: "local",
  signal: "local", // local daemon
};

// Transport-specific defaults
const TRANSPORT_PROFILES: Record<ChannelTransport, TransportProfile> = {
  websocket: {
    transport: "websocket",
    staleThresholdMs: 30 * 60_000, // 30min -- WebSocket should have heartbeats
    recoveryBudgetMs: 30_000, // 30s -- fast reconnect
    maxRetries: 5,
    stalePollFactor: 1, // not applicable
    restartBackoffInitialMs: 5_000,
    restartBackoffMaxMs: 5 * 60_000,
  },
  polling: {
    transport: "polling",
    staleThresholdMs: 30 * 60_000, // base 30min, multiplied by stalePollFactor
    recoveryBudgetMs: 90_000, // 90s -- polling is slower to recover
    maxRetries: 8, // more retries (polling is flakier)
    stalePollFactor: 2, // effective threshold: 60min
    restartBackoffInitialMs: 10_000, // slower initial backoff
    restartBackoffMaxMs: 10 * 60_000,
  },
  webhook: {
    transport: "webhook",
    staleThresholdMs: 0, // no stale detection (passive)
    recoveryBudgetMs: 60_000, // standard
    maxRetries: 5,
    stalePollFactor: 1,
    restartBackoffInitialMs: 5_000,
    restartBackoffMaxMs: 5 * 60_000,
  },
  local: {
    transport: "local",
    staleThresholdMs: 30 * 60_000,
    recoveryBudgetMs: 15_000, // 15s -- local process restarts fast
    maxRetries: 3, // fewer retries (if daemon is dead, retrying won't help)
    stalePollFactor: 2,
    restartBackoffInitialMs: 3_000,
    restartBackoffMaxMs: 2 * 60_000,
  },
};

export function resolveChannelTransport(channelId: string): ChannelTransport {
  return CHANNEL_TRANSPORT_MAP[channelId] ?? "websocket"; // default to websocket (safest)
}

export function getTransportProfile(channelId: string): TransportProfile {
  const transport = resolveChannelTransport(channelId);
  return TRANSPORT_PROFILES[transport];
}

// For extensions to register their transport type at runtime
export function registerChannelTransport(channelId: string, transport: ChannelTransport): void {
  CHANNEL_TRANSPORT_MAP[channelId] = transport;
}

export function isPollingChannel(channelId: string): boolean {
  const transport = resolveChannelTransport(channelId);
  return transport === "polling" || transport === "local";
}

export function isPassiveChannel(channelId: string): boolean {
  return resolveChannelTransport(channelId) === "webhook";
}

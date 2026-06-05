// Gateway event payload constants shared by server broadcasts and UI clients.
/** Event name emitted when a newer OpenClaw version is available. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Version metadata included in update-available gateway events. */
export type UpdateAvailableEventData = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
};

/** Gateway event payload for update availability broadcasts. */
export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailableEventData | null;
};

/** Event name emitted when chat latency metrics are available. */
export const GATEWAY_EVENT_CHAT_LATENCY = "chat.latency" as const;

/** Latency metrics for a chat response. */
export type ChatLatencyMetrics = {
  firstOutputMs: number;
  totalMs: number;
  outputTokens: number;
  throughputTokPerSec: number;
};

/** Gateway event payload for chat latency metric broadcasts. */
export type GatewayChatLatencyEventPayload = {
  latency: ChatLatencyMetrics;
};

import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { icons } from "./icons.ts";

export const SESSION_ATTENTION_ICON_NAMES = {
  hand: "hand",
  key: "key",
  alert: "alertTriangle",
  flag: "flag",
  lock: "lock",
  hourglass: "circle",
} as const satisfies Record<SessionAgentAttentionIconId, keyof typeof icons>;

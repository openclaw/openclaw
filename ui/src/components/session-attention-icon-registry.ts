import type { TemplateResult } from "lit";
import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { icons } from "./icons.ts";

export const SESSION_ATTENTION_ICON_NAMES = {
  hand: "hand",
  key: "key",
  alert: "alertTriangle",
  flag: "flag",
  lock: "lock",
  hourglass: "circle",
} as const satisfies Record<SessionAgentAttentionIconId, keyof typeof icons>;

export const SESSION_ATTENTION_ICONS = {
  hand: icons[SESSION_ATTENTION_ICON_NAMES.hand],
  key: icons[SESSION_ATTENTION_ICON_NAMES.key],
  alert: icons[SESSION_ATTENTION_ICON_NAMES.alert],
  flag: icons[SESSION_ATTENTION_ICON_NAMES.flag],
  lock: icons[SESSION_ATTENTION_ICON_NAMES.lock],
  hourglass: icons[SESSION_ATTENTION_ICON_NAMES.hourglass],
} as const satisfies Record<SessionAgentAttentionIconId, TemplateResult>;

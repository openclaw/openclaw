import type { TemplateResult } from "lit";
import type { SessionAgentAttentionIconId } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { icons } from "./icons.ts";

export const SESSION_ATTENTION_ICONS = {
  hand: icons.hand,
  key: icons.key,
  alert: icons.alertTriangle,
  flag: icons.flag,
  lock: icons.lock,
  hourglass: icons.circle,
} as const satisfies Record<SessionAgentAttentionIconId, TemplateResult>;

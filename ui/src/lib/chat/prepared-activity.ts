import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isAgentActivityItem } from "../protocol-validators.generated/activity.js";

export function readPreparedActivity(message: unknown): AgentActivityItem[] {
  const activity = asOptionalRecord(message)?.activity;
  return Array.isArray(activity) ? activity.filter(isAgentActivityItem) : [];
}

export function hasVisiblePreparedActivity(message: unknown): boolean {
  return readPreparedActivity(message).some(
    (activity) => !activity.hideFromChannelProgress && !activity.suppressChannelProgress,
  );
}

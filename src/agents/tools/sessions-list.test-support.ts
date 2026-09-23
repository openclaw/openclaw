import type { OpenClawConfig } from "../../config/types.openclaw.js";

export const VALID_CONFIG: OpenClawConfig = {
  agents: { entries: { main: { default: true } } },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
};

type SessionsListDetails = {
  count: number;
  hasMore: boolean;
  nextOffset?: number;
  limitApplied: number;
  truncationReason?: "scan-limit" | "byte-limit";
  sessions?: Array<{
    channel?: string;
    archived?: boolean;
    pinned?: boolean;
    stateVersion?: number;
    [key: string]: unknown;
  }>;
};

export function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

export function sessionRow(key: string, classification = "dashboard", agentId = "main") {
  return { key, agentId, kind: "direct", classification };
}

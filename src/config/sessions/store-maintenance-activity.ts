import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function isGatewayModelRunSessionKey(sessionKey: string): boolean {
  return /^agent:([^:\s]+):explicit:model-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sessionKey,
  );
}

export function getSessionMaintenanceActivityAt(
  entry:
    | Pick<SessionEntry, "updatedAt" | "lastInteractionAt" | "lastActivityAt" | "sessionStartedAt">
    | undefined,
): number {
  return Math.max(
    entry?.lastInteractionAt ?? 0,
    entry?.lastActivityAt ?? 0,
    entry?.sessionStartedAt ?? 0,
    entry?.updatedAt ?? 0,
  );
}

export function isSyntheticSessionMaintenanceKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  // ACP bridge sessions use normal model dispatch, but remain synthetic and disposable.
  return (
    isGatewayModelRunSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    rest.startsWith("acp-bridge:") ||
    rest.startsWith("hook:") ||
    rest.startsWith("node:") ||
    rest === "heartbeat" ||
    rest.endsWith(":heartbeat") ||
    rest.includes(":heartbeat:")
  );
}

export function isRecentSessionMaintenanceEntry(params: {
  key: string;
  entry: SessionEntry | undefined;
  preserveRecentMs?: number | null;
  nowMs?: number;
}): boolean {
  if (params.preserveRecentMs == null || isSyntheticSessionMaintenanceKey(params.key)) {
    return false;
  }
  const activityAt = getSessionMaintenanceActivityAt(params.entry);
  const now = params.nowMs ?? Date.now();
  return activityAt > 0 && now - activityAt <= params.preserveRecentMs;
}

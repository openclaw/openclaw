import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import {
  isCronSessionDisplayKey,
  isSubagentSessionRow,
  isSystemCreatedSessionRow,
} from "../shared/session-list-visibility.js";
import type { materializeSessionRow } from "./session-utils-row.js";

export function readSessionListSelectionFacts(
  key: string,
  entry?: {
    sessionId?: string;
    updatedAt?: number | null;
    spawnedBy?: string;
    category?: string;
    heartbeatIsolatedBaseSessionKey?: string;
    createdSurface?: "plugin-dock";
  } & Pick<
    SessionEntry,
    | "pinnedAt"
    | "parentSessionKey"
    | "sidebarRoot"
    | "lastActivityAt"
    | "lastInteractionAt"
    | "createdAt"
  > &
    Omit<Parameters<typeof isSystemCreatedSessionRow>[0], "key" | "classification">,
) {
  const parsed = parseAgentSessionKey(key);
  return {
    updatedAt: entry?.updatedAt ?? 0,
    lastInteractionAt: entry?.lastInteractionAt ?? 0,
    activity: entry ? sessionActivityTimestamp(entry) : 0,
    pinnedAt:
      entry?.pinnedAt !== undefined && isPinnableSessionEntry(key, entry)
        ? entry.pinnedAt
        : undefined,
    agentId: parsed ? normalizeAgentId(parsed.agentId) : undefined,
    isCronRun: isCronRunSessionKey(key),
    isCron: isCronSessionDisplayKey(key),
    isDock: entry?.createdSurface === "plugin-dock",
    isSystem: isSystemCreatedSessionRow({
      key,
      createdActor: entry?.createdActor,
      createdVia: entry?.createdVia,
      label: entry?.label,
      displayName: entry?.displayName,
      subject: entry?.subject,
      classification: entry?.heartbeatIsolatedBaseSessionKey ? "heartbeat" : undefined,
    }),
    isSubagent: isSubagentSessionRow(key, entry),
    isPhantom:
      entry?.updatedAt == null &&
      !normalizeOptionalString(entry?.sessionId) &&
      parsed?.rest === "sessions",
  } as const;
}

export type SessionListTargetLookup = (key: string) =>
  | {
      agentId: string;
      entry: SessionEntry;
      selection: ReturnType<typeof readSessionListSelectionFacts>;
      storeKey?: string;
      hasBoard?: boolean;
    }
  | undefined;

/** Cold rows prepare only the model facts needed by search. */
export type SessionListModelFactsLookup = (
  key: string,
) => Pick<
  ReturnType<typeof materializeSessionRow>["source"],
  "selectedModel" | "rowModelIdentity" | "thinkingProjection"
>;

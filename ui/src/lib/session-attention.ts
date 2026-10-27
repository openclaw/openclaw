import type { SessionAgentStatus } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "./format-error.ts";

export type SessionRowAttention =
  | { kind: "none" }
  | {
      kind: "agent";
      note: string;
      icon: NonNullable<SessionAgentStatus["attention"]>;
      sourceSessionKey: string;
    }
  | {
      kind: "error";
      reason: string;
      sourceSessionKey: string;
      /** Fences a dismissal to the failed session, not a replacement under the same key. */
      sourceSessionId?: string;
      /** The failed session's own unread marker and role, which its read acknowledgement needs. */
      sourceMarkedUnreadAt?: number;
      sourceSharingRole?: GatewaySessionRow["sharingRole"];
      childLabel?: string;
    };

export function activeSessionAgentStatus(
  row: Pick<GatewaySessionRow, "agentStatus">,
  now = Date.now(),
): SessionAgentStatus | undefined {
  const status = row.agentStatus;
  return status && status.expiresAt > now && status.note.trim() ? status : undefined;
}

/**
 * A failed run stays an alert until the session's read time passes its failure time.
 * Opening or dismissing the session writes that read time, so a later failure shows again.
 */
export function isUnacknowledgedSessionFailure(
  row: Pick<Partial<GatewaySessionRow>, "status" | "endedAt" | "updatedAt" | "lastReadAt">,
): boolean {
  const failureAt = row.endedAt ?? row.updatedAt ?? 0;
  return (
    (row.status === "failed" || row.status === "timeout") &&
    (row.lastReadAt == null || failureAt > row.lastReadAt)
  );
}

/** The same recorded attention feeds sidebar summaries and the owning conversation. */
export function sessionRowAttention(
  row: Partial<GatewaySessionRow> & { key: string },
  now = Date.now(),
): SessionRowAttention {
  if (row.archived) {
    return { kind: "none" };
  }
  const status = activeSessionAgentStatus(row, now);
  if (status?.attention) {
    return { kind: "agent", note: status.note, icon: status.attention, sourceSessionKey: row.key };
  }
  if (row.suppressErrorNotice || !isUnacknowledgedSessionFailure(row)) {
    return { kind: "none" };
  }
  return {
    kind: "error",
    reason:
      formatUiExternalText(row.lastRunError) ||
      t(
        row.status === "timeout" ? "sessionsView.runErrorTimedOut" : "sessionsView.runErrorUnknown",
      ),
    sourceSessionKey: row.key,
    ...(row.sessionId ? { sourceSessionId: row.sessionId } : {}),
    ...(row.markedUnreadAt != null ? { sourceMarkedUnreadAt: row.markedUnreadAt } : {}),
    ...(row.sharingRole ? { sourceSharingRole: row.sharingRole } : {}),
  };
}

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
  | { kind: "error"; reason: string; sourceSessionKey: string; childLabel?: string };

export function activeSessionAgentStatus(
  row: Pick<GatewaySessionRow, "agentStatus">,
  now = Date.now(),
): SessionAgentStatus | undefined {
  const status = row.agentStatus;
  return status && status.expiresAt > now && status.note.trim() ? status : undefined;
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
  const failureAt = row.endedAt ?? row.updatedAt ?? 0;
  if (
    (row.status !== "failed" && row.status !== "timeout") ||
    (row.lastReadAt != null && failureAt <= row.lastReadAt)
  ) {
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
  };
}

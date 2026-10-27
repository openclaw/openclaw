import { i18n } from "../../i18n/index.ts";
import type { SnapshotValue } from "../../lib/snapshot-json.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { detailsSnapshotSchema } from "./session-details-snapshot-schema.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
} from "./session-message-cache.ts";

export type ChatDetailsSnapshot = NonNullable<SnapshotValue<typeof detailsSnapshotSchema>>;
export type DetailsSubagents = NonNullable<ChatDetailsSnapshot["subagents"]>;
export type DetailsSubagent = DetailsSubagents["rows"][number];
export type DetailsAutomation = NonNullable<ChatDetailsSnapshot["automations"]>["rows"][number];
export type DetailsSnapshotPatch = Partial<Omit<ChatDetailsSnapshot, "locale">>;

export function isDetailsSubagentWorking(row: Pick<DetailsSubagent, "status">) {
  return row.status === "running" || row.status === "waiting";
}

export function projectDetailsSubagents(rows: readonly DetailsSubagent[], mobile = false) {
  return {
    total: rows.length,
    rows: [
      ...rows.filter(isDetailsSubagentWorking),
      ...rows.filter((row) => !isDetailsSubagentWorking(row)),
    ]
      .slice(0, rows.length > (mobile ? 3 : 5) ? 4 : 5)
      .map(({ key, label, status }) => ({ key, label, status })),
    counts: (["running", "waiting", "queued", "done", "stopped"] as const)
      .map((status) => ({
        status,
        count: rows.filter((row) => (row.status === "failed" ? "done" : row.status) === status)
          .length,
      }))
      .filter((entry) => entry.count > 0),
  };
}

/** Display receipts share the transcript's scope and incarnation, never live read authority. */
export function captureChatDetailsSnapshot(host: ChatPageHost) {
  const target = { sessionKey: host.sessionKey };
  const key = resolveChatSnapshotKey(host, target);
  const snapshot = readChatSessionSnapshot(host.chatMessagesBySession, host, target);
  if (!snapshot?.sessionId || snapshot.sessionId !== host.currentSessionId) {
    return undefined;
  }
  const client = host.client;
  const epoch = host.connectionEpoch;
  const locale = i18n.getLocale();
  return {
    snapshot,
    details: snapshot.details?.locale === locale ? snapshot.details : undefined,
    write: (patch: DetailsSnapshotPatch) => {
      if (
        !host.connected ||
        host.client !== client ||
        host.connectionEpoch !== epoch ||
        host.currentSessionId !== snapshot.sessionId ||
        resolveChatSnapshotKey(host, target) !== key ||
        host.sessionKey !== target.sessionKey ||
        i18n.getLocale() !== locale
      ) {
        return;
      }
      const current = readChatSessionSnapshot(host.chatMessagesBySession, host, target);
      if (!current || current.sessionId !== snapshot.sessionId) {
        return;
      }
      const details = {
        ...(current.details?.locale === locale ? current.details : {}),
        ...patch,
        locale,
      };
      if (JSON.stringify(details) === JSON.stringify(current.details)) {
        return;
      }
      cacheChatSessionSnapshot(host.chatMessagesBySession, host, target, { ...current, details });
    },
  };
}

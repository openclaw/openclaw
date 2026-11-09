import { i18n } from "../../i18n/index.ts";
import type { ChatDetailsSnapshot } from "./session-details-snapshot-schema.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatHistoryCursorHost,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export type DetailsSubagents = NonNullable<ChatDetailsSnapshot["subagents"]>;
export type DetailsSubagent = DetailsSubagents["rows"][number];
export type DetailsAutomation = NonNullable<ChatDetailsSnapshot["automations"]>["rows"][number];
export type DetailsSnapshotPatch = Partial<Omit<ChatDetailsSnapshot, "locale">>;
export const DETAILS_SUBAGENT_ACTIVITY_PREVIEW_ROWS = 3;

export function isDetailsSubagentWorking(row: Pick<DetailsSubagent, "status">) {
  return row.status === "running" || row.status === "waiting";
}

/** Older display receipts also contain subsessions; retain only the subagent collection. */
export function detailsSubagentCollection(value: DetailsSubagents): DetailsSubagents {
  return {
    total:
      value.total -
      value.counts.reduce((sum, entry) => sum + (entry.listed === false ? entry.count : 0), 0),
    rows: value.rows.filter((row) => row.listed !== false),
    counts: value.counts.filter((entry) => entry.listed !== false),
  };
}

export function projectDetailsSubagents(rows: readonly DetailsSubagent[], mobile = false) {
  const collection = rows.filter((row) => row.listed !== false);
  const counts: DetailsSubagents["counts"] = [];
  for (const row of collection) {
    const status = isDetailsSubagentWorking(row)
      ? "running"
      : row.status !== "queued"
        ? "done"
        : row.status;
    const count = counts.find((entry) => entry.status === status);
    if (count) {
      count.count += 1;
    } else {
      counts.push({ status, count: 1 });
    }
  }
  return {
    total: collection.length,
    rows: [
      ...collection.filter(isDetailsSubagentWorking),
      ...collection.filter((row) => !isDetailsSubagentWorking(row)),
    ]
      .slice(0, collection.length > (mobile ? 3 : 5) ? 4 : 5)
      .map(({ key, label, status, session }): DetailsSubagent => ({
        key,
        label,
        status,
        session: session && { startedAt: session.startedAt, endedAt: session.endedAt },
      })),
    counts: counts.toSorted((a, b) => {
      const order = ["running", "queued", "done", "failed", "stopped"];
      return order.indexOf(a.status) - order.indexOf(b.status);
    }),
  };
}

/** Display receipts share the transcript's scope and incarnation, never live read authority. */
export function captureChatDetailsSnapshot(
  host: ChatHistoryCursorHost & {
    chatMessagesBySession: ChatMessageCache;
    connectionEpoch: number;
  },
) {
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

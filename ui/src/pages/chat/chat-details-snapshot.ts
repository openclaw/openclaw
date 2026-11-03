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
    counts: projectSummaryCounts(rows),
  };
}

/**
 * The summary shows at most two statuses. Waiting parents are still working and
 * failed runs are finished; stopped runs only appear when nothing else exists.
 * The first status sits beside the avatars, the second is trailing.
 */
function projectSummaryCounts(rows: readonly DetailsSubagent[]) {
  const count = (matches: (row: DetailsSubagent) => boolean) => rows.filter(matches).length;
  const working = { status: "running" as const, count: count(isDetailsSubagentWorking) };
  const queued = { status: "queued" as const, count: count((row) => row.status === "queued") };
  const done = {
    status: "done" as const,
    count: count((row) => row.status === "done" || row.status === "failed"),
  };
  const stopped = { status: "stopped" as const, count: count((row) => row.status === "stopped") };
  const primary = [working, queued, done, stopped].find((entry) => entry.count > 0);
  if (!primary) {
    return [];
  }
  const secondary =
    primary === working ? (queued.count > 0 ? queued : done) : primary === queued ? done : null;
  return secondary?.count ? [primary, secondary] : [primary];
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

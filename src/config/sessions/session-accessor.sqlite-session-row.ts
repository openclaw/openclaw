import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../utils/delivery-context.shared.js";
import {
  normalizeSqliteChatType,
  normalizeSqliteText,
} from "./session-accessor.sqlite-normalize.js";
import { bindSessionEntryProvenance } from "./session-accessor.sqlite-provenance.js";
import {
  normalizeSqliteStatus,
  parseSqliteSessionEntryJson,
} from "./session-accessor.sqlite-status.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

const DERIVED_TITLE_MAX_LEN = 60;
const PROJECTED_TITLE = Symbol("projectedTitle");
type ProjectedTitleEntry = SessionEntry & { [PROJECTED_TITLE]?: string };
type SessionTitleDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_nodes"
  | "session_transcript_active_events"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

export function setSessionProjectedTitle(entry: SessionEntry, title: string | null): void {
  if (title) {
    Object.defineProperty(entry, PROJECTED_TITLE, {
      configurable: true,
      value: title,
      writable: true,
    });
  } else {
    delete (entry as ProjectedTitleEntry)[PROJECTED_TITLE];
  }
}

export function getSessionProjectedTitle(entry: SessionEntry | undefined): string | undefined {
  return (entry as ProjectedTitleEntry | undefined)?.[PROJECTED_TITLE];
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  for (const value of [entry.label, externalDisplayName, entry.displayName, entry.subject]) {
    const title = normalizeOptionalString(value);
    if (title) {
      return title;
    }
  }
  const normalized = firstUserMessage
    ? stripInboundMetadata(firstUserMessage).replace(/\s+/g, " ").trim()
    : "";
  if (normalized) {
    if (normalized.length <= DERIVED_TITLE_MAX_LEN) {
      return normalized;
    }
    const cut = truncateUtf16Safe(normalized, DERIVED_TITLE_MAX_LEN - 1);
    const lastSpace = cut.lastIndexOf(" ");
    return lastSpace > DERIVED_TITLE_MAX_LEN * 0.6 ? `${cut.slice(0, lastSpace)}…` : `${cut}…`;
  }
  if (!entry.sessionId) {
    return undefined;
  }
  const prefix = entry.sessionId.slice(0, 8);
  const updatedAt = entry.updatedAt && entry.updatedAt > 0 ? new Date(entry.updatedAt) : null;
  return updatedAt && Number.isFinite(updatedAt.getTime())
    ? `${prefix} (${updatedAt.toISOString().slice(0, 10)})`
    : prefix;
}

export function deriveSqliteSessionTitle(
  database: DatabaseSync,
  entry: SessionEntry,
): string | null {
  const db = getNodeSqliteKysely<SessionTitleDatabase>(database);
  const rows = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("event.event_json")
      .where("active.session_id", "=", entry.sessionId)
      .where("active.message_position", "is not", null)
      .orderBy("active.message_position", "asc"),
  );
  const hasActiveProjection = Boolean(
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("session_transcript_active_events")
        .select("active_position")
        .where("session_id", "=", entry.sessionId)
        .limit(1),
    ) ??
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", entry.sessionId),
    ),
  );
  if (hasActiveProjection) {
    return (
      deriveSessionTitleFromEventJson(
        entry,
        (function* () {
          for (const row of rows) {
            yield row.event_json;
          }
        })(),
      ) ?? null
    );
  }
  const provenance = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_windows")
      .select("session_entry_provenance")
      .where("session_id", "=", entry.sessionId),
  )?.session_entry_provenance;
  if (provenance !== 0) {
    return deriveSessionTitle(entry) ?? null;
  }
  const rawRows = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", entry.sessionId)
      .orderBy("seq", "asc"),
  );
  return (
    deriveSessionTitleFromEventJson(
      entry,
      (function* () {
        for (const row of rawRows) {
          yield row.event_json;
        }
      })(),
    ) ?? null
  );
}

function deriveSessionTitleFromEventJson(
  entry: SessionEntry,
  eventJsonRows: Iterable<string>,
): string | undefined {
  let firstUserMessage: string | undefined;
  for (const eventJson of eventJsonRows) {
    let parsed: { message?: unknown } | null;
    try {
      const value = JSON.parse(eventJson) as unknown;
      parsed = value && typeof value === "object" ? (value as { message?: unknown }) : null;
    } catch {
      continue;
    }
    const message = parsed?.message as
      | { content?: unknown; provenance?: unknown; role?: unknown; text?: unknown }
      | undefined;
    if (message?.role !== "user" || hasInterSessionUserProvenance(message)) {
      continue;
    }
    const text =
      extractTextFromChatContent(message.content) ??
      (typeof message.text === "string" ? message.text.trim() || null : null);
    if (text) {
      firstUserMessage = text;
      break;
    }
  }
  return deriveSessionTitle(entry, firstUserMessage);
}

export function refreshSqliteSessionTitleProjection(
  database: DatabaseSync,
  sessionId: string,
  onChanged?: () => void,
): void {
  const db = getNodeSqliteKysely<SessionTitleDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id", "entry_json", "updated_at", "display_name"])
      .where("current_session_id", "=", sessionId),
  ).rows;
  let changed = false;
  for (const row of rows) {
    const entry = parseSqliteSessionEntryJson(row);
    if (!entry) {
      continue;
    }
    const title = deriveSqliteSessionTitle(database, entry);
    if (row.display_name !== title) {
      executeSqliteQuerySync(
        database,
        db
          .updateTable("session_nodes")
          .set({ display_name: title })
          .where("session_key", "=", row.session_key),
      );
      changed = true;
    }
  }
  if (changed) {
    onChanged?.();
  }
}

export function normalizeSqliteSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  const raw = entry as unknown as Record<string, unknown>;
  const hasLegacyDeliveryFields = [
    "route",
    "deliveryContext",
    "origin",
    "channel",
    "lastChannel",
    "lastTo",
    "lastAccountId",
    "lastThreadId",
  ].some((key) => key in raw);
  const delivery =
    entry.delivery ?? (hasLegacyDeliveryFields ? undefined : { kind: "none" as const });
  if (typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)) {
    if (entry.delivery === delivery) {
      return entry;
    }
    return delivery ? { ...entry, delivery } : entry;
  }
  const updatedAt =
    typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)
      ? entry.sessionStartedAt
      : Date.now();
  return delivery ? { ...entry, delivery, updatedAt } : { ...entry, updatedAt };
}

export function bindSqliteSessionRoot(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const updatedAt = Number.isFinite(params.entry.updatedAt)
    ? params.entry.updatedAt
    : params.updatedAt;
  return {
    session_id: params.entry.sessionId,
    session_key: params.sessionKey,
    previous_session_id: normalizeSqliteText(params.entry.previousSessionId),
    reason: null,
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    ...bindSessionEntryProvenance(params.entry),
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeSqliteStatus(params.entry.status),
    chat_type: normalizeSqliteChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    primary_conversation_id: null,
    model_provider: normalizeSqliteText(params.entry.modelProvider),
    model: normalizeSqliteText(params.entry.model),
    agent_harness_id: normalizeSqliteText(params.entry.agentHarnessId),
    parent_session_key: normalizeSqliteText(params.entry.parentSessionKey),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

/** Project the canonical entry blob into the logical-node query columns. */
export function bindSqliteSessionNode(params: {
  entry: SessionEntry;
  projectedTitle: string | null;
  sessionKey: string;
  updatedAt: number;
}) {
  const canonicalEntry = projectCanonicalSessionEntryShape(
    params.entry as unknown as Record<string, unknown>,
  );
  const actor = params.entry.createdActor;
  const legacyActorId = normalizeSqliteText(
    (params.entry as SessionEntry & { createdBy?: { id?: unknown } }).createdBy?.id,
  );
  return {
    session_key: params.sessionKey,
    current_session_id: params.entry.sessionId,
    entry_json: JSON.stringify(canonicalEntry),
    entry_valid: 1,
    updated_at: params.updatedAt,
    status: normalizeSqliteStatus(params.entry.status),
    created_at: finiteSqliteNumber(params.entry.createdAt),
    created_via: normalizeSqliteCreatedVia(params.entry.createdVia),
    created_actor_type:
      normalizeSqliteCreatedActorType(actor?.type) ?? (legacyActorId ? "human" : null),
    created_actor_id: normalizeSqliteText(actor?.id) ?? legacyActorId,
    parent_session_key:
      normalizeSqliteText(params.entry.parentSessionKey) ??
      normalizeSqliteText(params.entry.spawnedBy),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    fork_source_session_key: normalizeSqliteText(params.entry.forkSource?.sessionKey),
    fork_source_session_id: normalizeSqliteText(params.entry.forkSource?.sessionId),
    fork_source_entry_id: normalizeSqliteText(params.entry.forkSource?.entryId),
    label: normalizeSqliteText(params.entry.label),
    display_name: params.projectedTitle,
    category: normalizeSqliteText(params.entry.category),
    icon: normalizeSqliteText(params.entry.icon),
    pinned_at: positiveSqliteNumber(params.entry.pinnedAt),
    archived_at: finiteSqliteNumber(params.entry.archivedAt),
    last_read_at: finiteSqliteNumber(params.entry.lastReadAt),
    last_interaction_at: positiveSqliteNumber(params.entry.lastInteractionAt),
    last_activity_at: finiteSqliteNumber(params.entry.lastActivityAt),
  };
}

function normalizeSqliteCreatedVia(value: SessionEntry["createdVia"]) {
  return value === "operator" ||
    value === "spawn" ||
    value === "channel" ||
    value === "cron" ||
    value === "talk" ||
    value === "run" ||
    value === "plugin" ||
    value === "internal"
    ? value
    : null;
}

function normalizeSqliteCreatedActorType(value: unknown) {
  return value === "human" || value === "agent" || value === "system" ? value : null;
}

function resolveSqliteSessionScope(
  entry: Pick<SessionEntry, "chatType">,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSqliteChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSqliteSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function finiteSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveSqliteSessionChannel(entry: SessionEntry): string | null {
  return normalizeSqliteText(sessionDeliveryChannel(entry));
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return normalizeSqliteText(deliveryContextFromSession(entry)?.accountId);
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.displayName) ??
    normalizeSqliteText(entry.label) ??
    normalizeSqliteText(entry.subject) ??
    normalizeSqliteText(entry.groupId)
  );
}

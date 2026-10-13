import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { parseSqliteSessionEntryRecord } from "../config/sessions/session-entry-json.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { buildConversationRef, normalizeConversationPeerId } from "../routing/conversation-ref.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { migrateLegacySessionCreator } from "./creator-namespace-migration.js";
import { ensurePendingInputConsumptionColumn } from "./openclaw-agent-pending-inputs-schema.js";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export function assertSupportedAgentMigrationSchemas(
  db: DatabaseSync,
  pathname: string,
  userVersion: number,
): void {
  if (
    (userVersion < 8 &&
      ["sessions", "session_entries", "transcript_events"].some((table) =>
        tableExists(db, table),
      )) ||
    tableExists(db, "session_transcript_files") ||
    readSqliteTableColumns(db, "session_transcript_fts")?.has("session_key")
  ) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} contains an unreleased session schema (version ${userVersion}). Preserve a complete copy of your state directory and configuration, including shared agent registration. Run "openclaw doctor --fix" with OpenClaw 2026.9.7 against that copy. If a store is held, follow Doctor's explicit agent-restoration instructions, then rerun Doctor before retrying the upgrade.`,
    );
  }
  const acpParentStreamColumns = readSqliteTableColumns(db, "acp_parent_stream_events");
  const trajectoryColumns = readSqliteTableColumns(db, "trajectory_runtime_events");
  const memorySourceColumns = readSqliteTableColumns(db, "memory_index_sources");
  if (
    (acpParentStreamColumns && !acpParentStreamColumns.has("session_id")) ||
    trajectoryColumns?.has("event_id") ||
    memorySourceColumns?.has("source_kind")
  ) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${pathname} has an unsupported legacy schema. Upgrades from pre-July-2026 state are no longer migrated; restore a backup produced by a July 2026 or newer release before retrying.`,
    );
  }
}

/** Backfill one generation token without copying or rewriting transcript rows. */
export function migrateSessionTranscriptGenerations(
  db: DatabaseSync,
  previousVersion: number,
): void {
  if (previousVersion >= 13) {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
     SELECT session_id, lower(hex(randomblob(16))), ?
     FROM transcript_events
     GROUP BY session_id`,
  );
  insert.setReadBigInts(true);
  insert.run(Date.now());
}

export function migrateSessionTranscriptActiveProjection(
  db: DatabaseSync,
  previousVersion: number,
): void {
  if (previousVersion >= 10) {
    return;
  }
  const columns = readSqliteTableColumns(db, "session_transcript_index_state");
  if (columns && !columns.has("active_event_count")) {
    db.exec(
      "ALTER TABLE session_transcript_index_state ADD COLUMN active_event_count INTEGER NOT NULL DEFAULT 0;",
    );
  }
  if (columns && !columns.has("active_message_count")) {
    db.exec(
      "ALTER TABLE session_transcript_index_state ADD COLUMN active_message_count INTEGER NOT NULL DEFAULT 0;",
    );
  }
  // This table is derived state. Gateway startup rebuilds it after all legacy
  // imports finish, keeping schema-open work cheap and history reads bounded.
  db.exec(`
    DELETE FROM session_transcript_active_events;
    UPDATE session_transcript_index_state
    SET needs_rebuild = 1,
        active_event_count = 0,
        active_message_count = 0,
        updated_at = ${Date.now()};
  `);
}

function inferMigratedChatType(params: {
  entry: Record<string, unknown>;
  persistedChatType?: string;
  sessionKey?: string;
  deliveryTarget?: string;
}): ChatType {
  const explicit =
    normalizeChatType(normalizeOptionalString(params.entry.chatType)) ??
    normalizeChatType(params.persistedChatType);
  if (explicit) {
    return explicit;
  }
  const keyType = deriveSessionChatTypeFromKey(params.sessionKey);
  if (keyType !== "unknown") {
    return keyType;
  }
  const target = params.deliveryTarget?.toLowerCase();
  if (target?.startsWith("channel:") || /^[^:]+:channel:/u.test(target ?? "")) {
    return "channel";
  }
  if (
    /^(?:[^:]+:)?(?:group|room):/u.test(target ?? "") ||
    normalizeOptionalString(params.entry.groupId)
  ) {
    return "group";
  }
  return "direct";
}

function migratedConversation(
  entry: Record<string, unknown>,
  persistedChatType?: string,
  sessionKey?: string,
) {
  const canonicalDelivery = asOptionalRecord(entry.delivery);
  const delivery =
    asOptionalRecord(canonicalDelivery?.context) ?? asOptionalRecord(entry.deliveryContext);
  const origin = asOptionalRecord(canonicalDelivery?.origin) ?? asOptionalRecord(entry.origin);
  const deliveryRouteTarget = normalizeOptionalString(delivery?.to);
  const originTarget = normalizeOptionalString(origin?.from);
  const kind = inferMigratedChatType({
    entry,
    persistedChatType,
    sessionKey,
    deliveryTarget: deliveryRouteTarget ?? originTarget,
  });
  const deliveryTarget = deliveryRouteTarget ?? (kind === "direct" ? originTarget : undefined);
  if (!deliveryTarget) {
    return undefined;
  }
  const routeOwnsTarget = Boolean(deliveryRouteTarget);
  const channel = (
    routeOwnsTarget
      ? (normalizeOptionalString(delivery?.channel) ??
        normalizeOptionalString(entry.channel) ??
        normalizeOptionalString(entry.lastChannel) ??
        normalizeOptionalString(origin?.provider))
      : normalizeOptionalString(origin?.provider)
  )?.toLowerCase();
  const accountId = normalizeAccountId(
    routeOwnsTarget
      ? (normalizeOptionalString(delivery?.accountId) ??
          normalizeOptionalString(entry.lastAccountId) ??
          normalizeOptionalString(origin?.accountId))
      : normalizeOptionalString(origin?.accountId),
  );
  const threadIdRaw = routeOwnsTarget ? delivery?.threadId : origin?.threadId;
  const threadId =
    typeof threadIdRaw === "number" && Number.isFinite(threadIdRaw)
      ? String(threadIdRaw)
      : normalizeOptionalString(threadIdRaw);
  // The routable target is authoritative for both identity and delivery. Stale
  // native metadata must never label one peer while sending to another.
  const peerId = channel ? normalizeConversationPeerId(channel, deliveryTarget) : undefined;
  if (!channel || !peerId) {
    return undefined;
  }
  // Stable threaded identity hashes the routed peer plus thread id. Parent
  // refs are transient correlation hints; persisting one would diverge from
  // live ingress identity for the same thread.
  return {
    conversationRef: buildConversationRef({ channel, accountId, kind, peerId, threadId }),
    channel,
    accountId,
    kind,
    peerId,
    deliveryTarget,
    threadId,
    nativeChannelId: normalizeOptionalString(origin?.nativeChannelId),
    nativeDirectUserId: normalizeOptionalString(origin?.nativeDirectUserId),
    label:
      normalizeOptionalString(entry.displayName) ??
      normalizeOptionalString(entry.label) ??
      normalizeOptionalString(entry.subject) ??
      normalizeOptionalString(entry.groupId),
  };
}

/** Backfills canonical external addresses once when conversation routing becomes active. */
export function backfillSessionConversations(db: DatabaseSync): void {
  if (
    !readSqliteTableColumns(db, "session_entries") ||
    !readSqliteTableColumns(db, "sessions") ||
    !readSqliteTableColumns(db, "conversations")
  ) {
    return;
  }
  if (!readSqliteTableColumns(db, "session_conversations")) {
    db.exec(`
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'participant', 'related')),
        route_context_json TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, conversation_id, role),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
      );
    `);
  }
  // Earlier schemas did not retain an exact delivery target. Remove their
  // derived projection, then rebuild only addresses recoverable from sessions.
  db.exec(`
    UPDATE sessions
    SET primary_conversation_id = NULL
    WHERE primary_conversation_id IN (
      SELECT conversation_id FROM conversations WHERE delivery_target = ''
    );
    DELETE FROM session_conversations
    WHERE conversation_id IN (
      SELECT conversation_id FROM conversations WHERE delivery_target = ''
    );
    DELETE FROM conversations WHERE delivery_target = '';
  `);
  const rows = db
    .prepare(
      `
        SELECT
          se.session_id,
          se.entry_json,
          se.session_key,
          se.updated_at,
          s.session_scope,
          CASE WHEN se.session_key = s.session_key THEN s.chat_type END AS persisted_chat_type
        FROM session_entries AS se
        INNER JOIN sessions AS s ON s.session_id = se.session_id
        ORDER BY se.updated_at ASC, se.session_key ASC;
      `,
    )
    .all();
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (
      conversation_id, channel, account_id, kind, peer_id, delivery_target,
      parent_conversation_id, thread_id, native_channel_id,
      native_direct_user_id, label, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel = excluded.channel,
      account_id = excluded.account_id,
      kind = excluded.kind,
      peer_id = excluded.peer_id,
      delivery_target = excluded.delivery_target,
      thread_id = excluded.thread_id,
      native_channel_id = excluded.native_channel_id,
      native_direct_user_id = excluded.native_direct_user_id,
      label = excluded.label,
      updated_at = excluded.updated_at;
  `);
  const deleteMatchingRelated = db.prepare(`
    DELETE FROM session_conversations
    WHERE session_id = ? AND conversation_id = ? AND role = 'related';
  `);
  const demotePrimary = db.prepare(`
    UPDATE session_conversations SET role = 'related', last_seen_at = ?
    WHERE session_id = ? AND role = 'primary';
  `);
  const linkConversation = db.prepare(`
    INSERT INTO session_conversations (
      session_id, conversation_id, role, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, conversation_id, role) DO UPDATE SET
      last_seen_at = excluded.last_seen_at;
  `);
  const updatePrimary = db.prepare(
    "UPDATE sessions SET primary_conversation_id = ? WHERE session_id = ?",
  );
  for (const statement of [
    upsertConversation,
    deleteMatchingRelated,
    demotePrimary,
    linkConversation,
    updatePrimary,
  ]) {
    statement.setReadBigInts(true);
  }
  for (const row of rows) {
    const sessionId = normalizeOptionalString(row.session_id);
    const entry =
      typeof row.entry_json === "string" ? safeParseJsonRecord(row.entry_json) : undefined;
    const updatedAt = typeof row.updated_at === "number" ? row.updated_at : Date.now();
    const conversation = entry
      ? migratedConversation(
          entry,
          normalizeOptionalString(row.persisted_chat_type),
          normalizeOptionalString(row.session_key),
        )
      : undefined;
    if (!sessionId || !conversation) {
      continue;
    }
    const role =
      row.session_scope === "shared-main" && conversation.kind === "direct"
        ? "participant"
        : "primary";
    upsertConversation.run(
      conversation.conversationRef,
      conversation.channel,
      conversation.accountId,
      conversation.kind,
      conversation.peerId,
      conversation.deliveryTarget,
      conversation.threadId ?? null,
      conversation.nativeChannelId ?? null,
      conversation.nativeDirectUserId ?? null,
      conversation.label ?? null,
      updatedAt,
      updatedAt,
    );
    if (role === "primary") {
      demotePrimary.run(updatedAt, sessionId);
      // The newly selected address may be the prior primary we just demoted.
      // Remove that related row before restoring its single canonical role.
      deleteMatchingRelated.run(sessionId, conversation.conversationRef);
    }
    linkConversation.run(sessionId, conversation.conversationRef, role, updatedAt, updatedAt);
    if (role === "primary") {
      updatePrimary.run(conversation.conversationRef, sessionId);
    }
  }
}

export function readSqliteTableColumns(db: DatabaseSync, tableName: string): Set<string> | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid SQLite table identifier: ${tableName}`);
  }
  if (!tableExists(db, tableName)) {
    return null;
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

/** Installs same-version session projections on first updated-binary open. */
export function ensureSessionAdditiveColumns(db: DatabaseSync): void {
  ensurePendingInputConsumptionColumn(db);
  // NULL records an older writer's unclassified projection; the transcript
  // reconcile owner fills it without parsing payloads during schema open.
  ensureColumn(db, "session_transcript_active_events", "context_eligible INTEGER");
  ensureColumn(db, "session_nodes", "project_id TEXT");
  ensureColumn(db, "session_conversations", "route_context_json TEXT");
  if (
    tableExists(db, "session_conversations") &&
    !getAdmittedSqliteSchemaFacts(db)?.triggers.has(
      "session_conversations_route_context_invalidate_after_update",
    )
  ) {
    // Same-version older writers leave the envelope byte-identical. Clear it on their update so
    // stale owner facts cannot survive a downgrade/re-upgrade cycle with an unchanged timestamp.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_conversations_route_context_invalidate_after_update
      AFTER UPDATE OF role, last_seen_at ON session_conversations
      WHEN NEW.route_context_json IS OLD.route_context_json
      BEGIN
        UPDATE session_conversations
        SET route_context_json = NULL
        WHERE session_id = NEW.session_id
          AND conversation_id = NEW.conversation_id
          AND role = NEW.role;
      END;
    `);
  }
}

export function hasPendingSessionConversationRouteContextColumn(db: DatabaseSync): boolean {
  const columns = readSqliteTableColumns(db, "session_conversations");
  return Boolean(columns && !columns.has("route_context_json"));
}

export function hasPendingSessionProjectColumn(db: DatabaseSync): boolean {
  const columns = readSqliteTableColumns(db, "session_nodes");
  return Boolean(columns && !columns.has("project_id"));
}

export function hasPendingSessionTranscriptContextEligibilityColumn(db: DatabaseSync): boolean {
  const columns = readSqliteTableColumns(db, "session_transcript_active_events");
  return Boolean(columns && !columns.has("context_eligible"));
}

/** Adds the v11 exact delivery target before the conversation backfill writes canonical rows. */
export function migrateConversationDeliveryTargetColumn(db: DatabaseSync): void {
  // SQLite requires a default for a NOT NULL additive column. The canonical
  // session projection replaces recoverable rows; backfill drops the rest.
  ensureColumn(db, "conversations", "delivery_target TEXT NOT NULL DEFAULT ''");
}

/** Adds the validity projection and settles only rows left pending by older writers. */
export function ensureSessionEntryValidityProjection(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "session_nodes");
  if (!columns) {
    return;
  }
  const addedColumn = !columns.has("entry_valid");
  if (addedColumn) {
    db.exec(
      "ALTER TABLE session_nodes ADD COLUMN entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1))",
    );
  }
  const selectPending = db.prepare(
    "SELECT current_session_id, entry_json, session_key, updated_at FROM session_nodes WHERE entry_valid = 0 ORDER BY session_key LIMIT 256",
  );
  const update = db.prepare("UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?");
  // run() also returns the connection's last insert rowid, including after rollback.
  update.setReadBigInts(true);
  while (true) {
    // Exhaust the bounded SELECT before updating its source table; SQLite does not define
    // stepping a cursor while the same connection mutates rows visible to that cursor.
    const rows = selectPending.all() as Array<{
      current_session_id: string;
      entry_json: string;
      session_key: string;
      updated_at: number;
    }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      update.run(parseSqliteSessionEntryRecord(row) ? 1 : -1, row.session_key);
    }
  }
}

export function migrateSessionCreatorNamespaces(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 19 || !tableExists(db, "session_nodes")) {
    return;
  }
  const update = db.prepare(
    "UPDATE session_nodes SET entry_json = ?, created_actor_type = ?, created_actor_id = ? WHERE session_key = ?",
  );
  update.setReadBigInts(true);
  const rows = db.prepare(`SELECT session_key, entry_json FROM session_nodes
    WHERE json_valid(entry_json) AND (json_extract(entry_json, '$.createdActor.type') = 'human'
      OR (json_type(entry_json, '$.createdActor') IS NULL AND json_type(entry_json, '$.createdBy') = 'object'))`);
  // SAFETY: The query selects the two declared, non-null TEXT columns without projection casts.
  for (const row of rows.all() as Array<{ session_key: string; entry_json: string }>) {
    // SAFETY: SQL admits valid JSON with a human actor or legacy actor object; all other fields are retained verbatim.
    const entry = migrateLegacySessionCreator(JSON.parse(row.entry_json) as SessionEntry);
    update.run(
      JSON.stringify(entry),
      entry.createdActor?.type ?? null,
      entry.createdActor?.id ?? null,
      row.session_key,
    );
  }
}

import { createHash } from "node:crypto";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasLegacyAcpMigrationProvenanceColumn } from "../../state/openclaw-agent-legacy-acp-schema.js";
import { ensureOpenClawAgentProgressCardSchemaInTransaction } from "../../state/openclaw-agent-progress-card-schema.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { copyLegacyAcpMigrationSourcesForRepair } from "./session-accessor.sqlite-acp-provenance.js";
import {
  copySessionInputCompletionsForRepair,
  copySessionPendingInputsForRepair,
} from "./session-accessor.sqlite-pending-inputs-repair.js";
import { deleteSessionPendingInputs } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { mergeParticipantAggregate } from "./session-participant-identity.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

/** Logical-node facts survive history cleanup and are fenced at final entry deletion. */
export function readSessionNodeArtifactFingerprint(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): string {
  const db = getSessionKysely(database.db);
  const present = readSessionNodeArtifactTables(database);
  const fingerprint = createHash("sha256");
  const inventories = {
    board_tabs: db
      .selectFrom("board_tabs")
      .selectAll()
      .where("session_key", "=", sessionKey)
      .orderBy("tab_id"),
    heartbeat_outcomes: db
      .selectFrom("heartbeat_outcomes")
      .selectAll()
      .where("session_key", "=", sessionKey),
    session_members: db
      .selectFrom("session_members")
      .selectAll()
      .where("session_key", "=", sessionKey)
      .orderBy("identity_id"),
    session_participants: db
      .selectFrom("session_participants")
      .selectAll()
      .where("session_key", "=", sessionKey)
      .orderBy("identity_namespace")
      .orderBy("actor_id"),
    session_progress_cards: db
      .selectFrom("session_progress_cards")
      .selectAll()
      .where("session_key", "=", sessionKey),
    session_suggestions: db
      .selectFrom("session_suggestions")
      .selectAll()
      .where("session_key", "=", sessionKey)
      .orderBy("state")
      .orderBy("created_at")
      .orderBy("id"),
  };
  for (const [table, query] of Object.entries(inventories)) {
    fingerprint.update(table).update("\n");
    if (present.has(table)) {
      for (const row of iterateSqliteQuerySync<unknown>(database.db, query)) {
        fingerprint.update(JSON.stringify(row)).update("\n");
      }
    }
  }
  fingerprint.update("board_widgets\n");
  if (present.has("board_widgets")) {
    for (const { html, ...metadata } of iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("board_widgets")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .orderBy("name"),
    )) {
      fingerprint.update(JSON.stringify(metadata)).update("\n");
      // JSON would expand each HTML byte into text; hash the stored bytes directly.
      fingerprint.update(html === null ? "null\n" : `bytes:${html.byteLength}\n`);
      if (html !== null) {
        fingerprint.update(html).update("\n");
      }
    }
  }
  const provenance = hasLegacyAcpMigrationProvenanceColumn(database.db)
    ? executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select("legacy_acp_migration_json")
          .where("session_key", "=", sessionKey),
      )?.legacy_acp_migration_json
    : undefined;
  return fingerprint
    .update("legacy_acp_migration_json\n")
    .update(JSON.stringify(provenance ?? null))
    .digest("hex");
}

export function clearSessionCollaborationForKey(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: { clearSuggestions?: boolean } = {},
): void {
  const presentTables = readSessionNodeArtifactTables(database);
  const db = getSessionKysely(database.db);
  if (presentTables.has("session_members")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_members").where("session_key", "=", sessionKey),
    );
  }
  if (options.clearSuggestions !== false && presentTables.has("session_suggestions")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_suggestions").where("session_key", "=", sessionKey),
    );
  }
}

/** Copy logical-session artifacts into their canonical node within one agent store or across two. */
export function copySessionNodeArtifactsForRepair(
  source: Pick<OpenClawAgentDatabase, "db" | "path">,
  destination: OpenClawAgentDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
  options: { includeMembers?: boolean; includeParticipants?: boolean } = {},
): void {
  const keys = [...new Set(sourceKeys)];
  if (keys.length === 0) {
    return;
  }
  copySessionPendingInputsForRepair(source, destination, keys, canonicalKey);
  copySessionInputCompletionsForRepair(source, destination, keys, canonicalKey);
  copyLegacyAcpMigrationSourcesForRepair(source, destination, keys, canonicalKey);
  const sourceDb = getSessionKysely(source.db);
  const destinationDb = getSessionKysely(destination.db);
  const sourceKeyReferences = new Set(keys.flatMap((key) => [key, key.trim()]));
  const sourceTables = readSessionNodeArtifactTables(source);
  let destinationTables = readSessionNodeArtifactTables(destination);
  if (
    options.includeParticipants !== false &&
    sourceTables.has("session_participants") &&
    !destinationTables.has("session_participants")
  ) {
    ensureSessionParticipantsSchema(destination.db);
    destinationTables = readSessionNodeArtifactTables(destination);
  }
  if (sourceTables.has("session_progress_cards")) {
    const progressCards = executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_progress_cards").selectAll().where("session_key", "in", keys),
    ).rows;
    // Keep destination storage dormant unless an owned row actually needs transfer.
    if (progressCards.length > 0 && !destinationTables.has("session_progress_cards")) {
      ensureOpenClawAgentProgressCardSchemaInTransaction(destination.db);
      destinationTables = readSessionNodeArtifactTables(destination);
    }
    for (const progressCard of progressCards) {
      const canonicalProgressCard = { ...progressCard, session_key: canonicalKey };
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_progress_cards")
          .values(canonicalProgressCard)
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet(canonicalProgressCard)
              .where((eb) =>
                eb.or([
                  eb("revision", "<", progressCard.revision),
                  eb.and([
                    eb("revision", "=", progressCard.revision),
                    eb("updated_at", "<", progressCard.updated_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (
    sourceTables.has("board_tabs") &&
    sourceTables.has("board_widgets") &&
    destinationTables.has("board_tabs") &&
    destinationTables.has("board_widgets")
  ) {
    for (const tab of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("board_tabs").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("board_tabs")
          .values({ ...tab, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "tab_id"])
              .doUpdateSet({
                title: tab.title,
                position: tab.position,
                chat_dock: tab.chat_dock,
                created_by: tab.created_by,
                revision: tab.revision,
              })
              .where("revision", "<", tab.revision),
          ),
      );
    }
    for (const widget of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("board_widgets").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("board_widgets")
          .values({ ...widget, session_key: canonicalKey })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "name"])
              .doUpdateSet({ ...widget, session_key: canonicalKey })
              .where((eb) =>
                eb.or([
                  eb("revision", "<", widget.revision),
                  eb.and([
                    eb("revision", "=", widget.revision),
                    eb("updated_at", "<", widget.updated_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (
    options.includeMembers !== false &&
    sourceTables.has("session_members") &&
    destinationTables.has("session_members")
  ) {
    for (const member of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_members").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_members")
          .values({ ...member, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
      );
    }
  }
  if (sourceTables.has("session_suggestions") && destinationTables.has("session_suggestions")) {
    if (source.db === destination.db) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .updateTable("session_suggestions")
          .set({ session_key: canonicalKey })
          .where("session_key", "in", keys),
      );
    } else {
      for (const suggestion of executeSqliteQuerySync(
        source.db,
        sourceDb.selectFrom("session_suggestions").selectAll().where("session_key", "in", keys),
      ).rows) {
        executeSqliteQuerySync(
          destination.db,
          destinationDb
            .insertInto("session_suggestions")
            .values({ ...suggestion, session_key: canonicalKey })
            .onConflict((conflict) => conflict.column("id").doNothing()),
        );
      }
    }
  }
  if (sourceTables.has("heartbeat_outcomes") && destinationTables.has("heartbeat_outcomes")) {
    for (const heartbeat of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("heartbeat_outcomes").selectAll().where("session_key", "in", keys),
    ).rows) {
      const canonicalHeartbeat = {
        ...heartbeat,
        session_key: canonicalKey,
        run_session_key: sourceKeyReferences.has(heartbeat.run_session_key)
          ? canonicalKey
          : heartbeat.run_session_key,
      };
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("heartbeat_outcomes")
          .values(canonicalHeartbeat)
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet(canonicalHeartbeat)
              .where((eb) =>
                eb.or([
                  eb("updated_at", "<", heartbeat.updated_at),
                  eb.and([
                    eb("updated_at", "=", heartbeat.updated_at),
                    eb("occurred_at", "<", heartbeat.occurred_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
  if (
    options.includeParticipants !== false &&
    sourceTables.has("session_participants") &&
    destinationTables.has("session_participants")
  ) {
    for (const participant of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("session_participants").selectAll().where("session_key", "in", keys),
    ).rows) {
      if (source.db === destination.db && participant.session_key === canonicalKey) {
        continue;
      }
      const existing = executeSqliteQueryTakeFirstSync(
        destination.db,
        destinationDb
          .selectFrom("session_participants")
          .select(["contribution_count", "first_prompted_at", "last_prompted_at"])
          .where("session_key", "=", canonicalKey)
          .where("identity_namespace", "=", participant.identity_namespace)
          .where("actor_id", "=", participant.actor_id),
      );
      const aggregate = mergeParticipantAggregate(
        existing,
        participant,
        source.db === destination.db ? "sum" : "copy",
      );
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("session_participants")
          .values({
            ...participant,
            ...aggregate,
            session_key: canonicalKey,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["session_key", "identity_namespace", "actor_id"])
              .doUpdateSet(aggregate),
          ),
      );
    }
  }
}

/** Membership is authorization state; canonical repair replaces it from the selected winner. */
export function deleteSessionMembersForRepair(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  if (!readSessionNodeArtifactTables(database).has("session_members")) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_members").where("session_key", "=", sessionKey),
  );
}

export function deleteSessionDeliveryArtifacts(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  additionalKeys: readonly string[] = [],
): void {
  const db = getSessionKysely(database.db);
  const trimmedKey = sessionKey.trim();
  const lookupKeys = uniqueStrings([
    sessionKey,
    trimmedKey,
    normalizeStoreSessionKey(trimmedKey),
    ...additionalKeys,
  ]);
  let sessionKeys = lookupKeys;
  if (lookupKeys.some((key) => key !== sessionKey)) {
    const competingIdentities = new Set(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_nodes").select("session_key"),
      ).rows.flatMap((row) =>
        row.session_key === sessionKey ? [] : [normalizeStoreSessionKey(row.session_key.trim())],
      ),
    );
    sessionKeys = lookupKeys.filter(
      (key) => key === sessionKey || !competingIdentities.has(normalizeStoreSessionKey(key.trim())),
    );
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("conversation_deliveries").where("source_session_key", "in", sessionKeys),
  );
}

export function deleteSessionNodeArtifacts(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  deleteSessionPendingInputs(database, sessionKey);
  const db = getSessionKysely(database.db);
  const presentTables = readSessionNodeArtifactTables(database);
  if (presentTables.has("board_tabs") && presentTables.has("board_widgets")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_widgets").where("session_key", "=", sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_tabs").where("session_key", "=", sessionKey),
    );
  }
  for (const table of [
    "heartbeat_outcomes",
    "session_participants",
    "session_progress_cards",
    "session_members",
    "session_suggestions",
  ] as const) {
    if (!presentTables.has(table)) {
      continue;
    }
    executeSqliteQuerySync(database.db, db.deleteFrom(table).where("session_key", "=", sessionKey));
  }
}

function readSessionNodeArtifactTables(database: Pick<OpenClawAgentDatabase, "db">): Set<string> {
  const db = getSessionKysely(database.db);
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", [
          "board_tabs",
          "board_widgets",
          "heartbeat_outcomes",
          "session_members",
          "session_participants",
          "session_progress_cards",
          "session_suggestions",
        ]),
    ).rows.flatMap((row) => (row.name ? [row.name] : [])),
  );
}

import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  claimUnchanged,
  claimsMatch,
  generationsMatch,
  readClaim,
} from "./legacy-main-session-migration-claims.js";
import type { PhysicalStore, SessionClaim } from "./legacy-main-session-migration.contract.js";
import { copySessionDeliveriesForRepair } from "./session-accessor.sqlite-delivery-repair.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  copySqliteSessionGenerationRows,
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
  rehomeSqliteSessionGenerationWindow,
} from "./session-accessor.sqlite-generation-copy.js";
import type { SqliteSessionGenerationClaim } from "./session-accessor.sqlite-generation.types.js";
import { invalidateSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export function writeSessionClaimForRepair(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  invalidateSessionEntryMaintenanceAgeFact(database.db);
  writeSessionEntry(database, sessionKey, entry, {
    allowStoredAliases: true,
    previousEntry: null,
  });
  replaceSessionOwnerInTransaction(database, sessionKey, entry.owner);
}

export async function copySessionClaimForRepair(params: {
  beforePersistentApply?: () => void;
  canonicalKey: string;
  destination: PhysicalStore;
  expectedDestination?: SessionClaim;
  env: NodeJS.ProcessEnv;
  source: SessionClaim;
  mode: "legacy-main" | "store-relocation";
}): Promise<SessionClaim | undefined> {
  const destinationOptions = {
    agentId: params.destination.databaseAgentId,
    env: params.env,
    path: params.destination.path,
  };
  return await runExclusiveSqliteSessionWrite(
    destinationOptions,
    async () => {
      params.beforePersistentApply?.();
      return runOpenClawAgentWriteTransaction(
        (destinationDatabase) => {
          const current = readClaim(
            destinationDatabase,
            params.destination,
            params.canonicalKey,
            params.canonicalKey,
          );
          if (
            (params.expectedDestination &&
              (!current || !claimUnchanged(current, params.expectedDestination))) ||
            (current && !claimsMatch(params.source, current))
          ) {
            return undefined;
          }
          const source = withOpenClawAgentDatabaseReadOnly(
            (sourceDatabase) =>
              runSqliteDeferredTransactionSync(sourceDatabase.db, () => {
                const fresh = readClaim(
                  sourceDatabase,
                  params.source.store,
                  params.source.key,
                  params.canonicalKey,
                );
                if (
                  !fresh ||
                  !claimUnchanged(fresh, params.source) ||
                  fresh.databaseIdentity ===
                    readOpenClawAgentDatabaseIdentity(destinationDatabase).identity
                ) {
                  return undefined;
                }
                if (
                  params.mode === "store-relocation" &&
                  current &&
                  JSON.stringify(
                    listSessionMembersInDatabase(sourceDatabase, fresh.key).map(
                      (member) => member.identityId,
                    ),
                  ) !==
                    JSON.stringify(
                      listSessionMembersInDatabase(destinationDatabase, params.canonicalKey).map(
                        (member) => member.identityId,
                      ),
                    )
                ) {
                  return undefined;
                }
                const destinationWindows = new Map(
                  readSqliteSessionGenerationWindows(
                    destinationDatabase,
                    [],
                    fresh.generations.map((generation) => generation.window.session_id),
                  ).map((window) => [window.session_id, window]),
                );
                const currentGenerations = new Map(
                  current?.generations.map((generation) => [
                    generation.window.session_id,
                    generation,
                  ]),
                );
                const missing: SqliteSessionGenerationClaim[] = [];
                for (const generation of fresh.generations) {
                  assertSessionTranscriptHot(sourceDatabase.db, generation.window.session_id);
                  if (
                    normalizeStoreSessionKey(generation.window.session_key.trim()) !==
                    normalizeStoreSessionKey(params.source.key.trim())
                  ) {
                    return undefined;
                  }
                  const existing = destinationWindows.get(generation.window.session_id);
                  if (!existing) {
                    missing.push(generation);
                  } else if (
                    existing.session_key !== params.canonicalKey ||
                    !generationsMatch(
                      generation,
                      currentGenerations.get(existing.session_id) ??
                        readSqliteSessionGenerationClaim(destinationDatabase, existing),
                      params.canonicalKey,
                    )
                  ) {
                    return undefined;
                  }
                }
                if (!current) {
                  if (readExactSessionEntryRow(destinationDatabase, params.canonicalKey)) {
                    return undefined;
                  }
                  writeSessionClaimForRepair(destinationDatabase, params.canonicalKey, fresh.entry);
                }
                const sourceDb = getSessionKysely(sourceDatabase.db);
                const destinationDb = getSessionKysely(destinationDatabase.db);
                const sourceKeys = new Set([normalizeStoreSessionKey(params.source.key.trim())]);
                for (const generation of missing) {
                  const window = generation.window;
                  const links = executeSqliteQuerySync(
                    sourceDatabase.db,
                    sourceDb
                      .selectFrom("session_conversations")
                      .selectAll()
                      .where("session_id", "=", window.session_id),
                  ).rows;
                  const conversationIds = [
                    ...(window.primary_conversation_id ? [window.primary_conversation_id] : []),
                    ...links.map((link) => link.conversation_id),
                  ];
                  for (const conversation of executeSqliteQuerySync(
                    sourceDatabase.db,
                    sourceDb
                      .selectFrom("conversations")
                      .selectAll()
                      .where("conversation_id", "in", sqliteStringSet(conversationIds)),
                  ).rows) {
                    executeSqliteQuerySync(
                      destinationDatabase.db,
                      destinationDb
                        .insertInto("conversations")
                        .values(conversation)
                        .onConflict((conflict) => conflict.column("conversation_id").doNothing()),
                    );
                  }
                  const mapped = rehomeSqliteSessionGenerationWindow(
                    window,
                    params.canonicalKey,
                    sourceKeys,
                  );
                  executeSqliteQuerySync(
                    destinationDatabase.db,
                    destinationDb
                      .insertInto("session_windows")
                      .values(mapped)
                      // A new logical entry already created its current window in this transaction.
                      .onConflict((conflict) => conflict.column("session_id").doUpdateSet(mapped)),
                  );
                  copySqliteSessionGenerationRows({
                    destination: destinationDatabase,
                    source: sourceDatabase,
                    sessionId: window.session_id,
                    sourceWindowPresent: true,
                  });
                  executeSqliteQuerySync(
                    destinationDatabase.db,
                    destinationDb
                      .deleteFrom("session_conversations")
                      .where("session_id", "=", window.session_id),
                  );
                  for (const link of links) {
                    executeSqliteQuerySync(
                      destinationDatabase.db,
                      destinationDb.insertInto("session_conversations").values(link),
                    );
                  }
                }
                if (params.mode === "store-relocation") {
                  copySessionDeliveriesForRepair({
                    source: sourceDatabase,
                    destination: destinationDatabase,
                    sourceKeys: [fresh.key],
                    canonicalKey: params.canonicalKey,
                    preserveDestination: true,
                  });
                }
                copySessionNodeArtifactsForRepair(
                  sourceDatabase,
                  destinationDatabase,
                  [fresh.key],
                  params.canonicalKey,
                  { includeMembers: params.mode === "store-relocation" },
                );
                return readClaim(
                  destinationDatabase,
                  params.destination,
                  params.canonicalKey,
                  params.canonicalKey,
                );
              }),
            {
              agentId: params.source.store.databaseAgentId,
              env: params.env,
              path: params.source.store.path,
            },
          );
          return source.found ? source.value : undefined;
        },
        destinationOptions,
        { operationLabel: "session.repair.copy-claim" },
      );
    },
    "session-repair.copy",
  );
}

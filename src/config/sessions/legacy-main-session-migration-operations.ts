import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import {
  claimFullyCopied,
  claimUnchanged,
  claimsMatch,
  generationsMatch,
  readClaim,
} from "./legacy-main-session-migration-claims.js";
import type {
  LegacyMainSessionMigrationMode,
  LegacyMainSessionMigrationOutcome,
  PhysicalStore,
  SessionClaim,
} from "./legacy-main-session-migration.contract.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import {
  deleteLegacySessionEntryRows,
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
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { invalidateSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export function samePhysicalStore(left: PhysicalStore, right: PhysicalStore): boolean {
  return isSameOpenClawAgentDatabasePath(left.path, right.path);
}

function freshestClaim(claims: readonly SessionClaim[]): SessionClaim {
  return claims.toSorted((left, right) => {
    const freshness = (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
    return (
      freshness ||
      left.key.localeCompare(right.key) ||
      left.store.path.localeCompare(right.store.path)
    );
  })[0]!;
}

export function warningForDivergence(
  kind: "divergent-aliases" | "divergent-canonical",
  canonicalKey: string,
  claims: readonly SessionClaim[],
): string {
  const claimsText = claims.map((claim) => `${claim.store.path}#${claim.key}`).join(", ");
  return `session: ${kind} for ${canonicalKey}; preserved claims ${claimsText}. Run openclaw doctor --fix to quarantine the losing claims.`;
}

function writeMigratedSessionClaim(
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

function mutateLegacySessionClaims<T>(
  params: {
    store: PhysicalStore;
    env: NodeJS.ProcessEnv;
    claims: readonly SessionClaim[];
    operationLabel:
      | "session-migration.legacy-main-in-place"
      | "session-migration.legacy-main-quarantine";
    beforePersistentApply?: () => void;
  },
  commit: (database: OpenClawAgentDatabase) => T,
): Promise<T> {
  const scope = {
    agentId: params.store.databaseAgentId,
    env: params.env,
    path: params.store.path,
    ownerStorePath: params.store.ownerStorePath,
  };
  return withSqliteSessionDeletions(
    scope,
    params.claims.map(({ key: sessionKey, entry }) => ({ sessionKey, entry })),
    async (assertCurrent) =>
      runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          assertCurrent();
          params.beforePersistentApply?.();
          return runSqliteSessionDeletionTransaction(commit, scope, {
            operationLabel: params.operationLabel,
          });
        },
        params.operationLabel,
      ),
  );
}

function migrateClaimsInPlace(params: {
  beforePersistentApply?: () => void;
  aliases: readonly SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  env: NodeJS.ProcessEnv;
  store: PhysicalStore;
  winner: SessionClaim;
}): Promise<SessionClaim | undefined> {
  return mutateLegacySessionClaims(
    {
      ...params,
      claims: params.aliases.filter((claim) => claim.key !== params.canonicalKey),
      operationLabel: "session-migration.legacy-main-in-place",
    },
    (database) => {
      const currentAliases = params.aliases.map((claim) =>
        readClaim(database, params.store, claim.key, params.canonicalKey),
      );
      // Absence is part of the snapshot: owner preparation may let a new canonical row appear.
      const currentCanonical = readClaim(
        database,
        params.store,
        params.canonicalKey,
        params.canonicalKey,
      );
      if (
        currentAliases.some(
          (claim, index) => !claim || !claimUnchanged(claim, params.aliases[index]!),
        ) ||
        (params.canonical
          ? !currentCanonical || !claimUnchanged(currentCanonical, params.canonical)
          : currentCanonical !== undefined)
      ) {
        return undefined;
      }
      if (!currentCanonical) {
        writeMigratedSessionClaim(database, params.canonicalKey, params.winner.entry);
      }
      deleteLegacySessionEntryRows(
        database,
        params.aliases.map((claim) => claim.key),
        params.canonicalKey,
        {
          rehomeMembers: true,
          validatedEntries: new Map(currentAliases.map((claim) => [claim!.key, claim!.entry])),
        },
      );
      return readClaim(database, params.store, params.canonicalKey, params.canonicalKey);
    },
  );
}

async function copyClaimCrossStore(params: {
  beforePersistentApply?: () => void;
  canonicalKey: string;
  destination: PhysicalStore;
  expectedDestination?: SessionClaim;
  env: NodeJS.ProcessEnv;
  source: SessionClaim;
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
      return runOpenClawAgentWriteTransaction((destinationDatabase) => {
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
                writeMigratedSessionClaim(destinationDatabase, params.canonicalKey, fresh.entry);
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
              copySessionNodeArtifactsForRepair(
                sourceDatabase,
                destinationDatabase,
                [fresh.key],
                params.canonicalKey,
                { includeMembers: false },
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
      }, destinationOptions);
    },
    "session-migration.legacy-main-copy",
  );
}

async function deleteExpectedClaim(
  claim: SessionClaim,
  commitGuard?: () => void,
): Promise<boolean> {
  const result = await deleteSessionEntryLifecycle({
    commitGuard,
    agentId: claim.store.databaseAgentId,
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    expectedEntry: claim.entry,
    expectedDatabaseIdentity: claim.databaseIdentity,
    expectedGenerations: claim.generations,
    expectedNodeArtifactFingerprint: claim.nodeArtifactFingerprint,
    requireWriteSuccess: true,
    storePath: claim.store.ownerStorePath,
    target: { canonicalKey: claim.key, storeKeys: [claim.key] },
  });
  return result.deleted;
}

async function deleteCopiedClaims(params: {
  aliases: readonly SessionClaim[];
  beforePersistentApply?: () => void;
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  receipt: SessionClaim;
}): Promise<SessionClaim | undefined> {
  const sources = params.aliases.filter(
    (claim) => !samePhysicalStore(claim.store, params.destination),
  );
  if (sources.length === 0) {
    return undefined;
  }
  const options = {
    agentId: params.destination.databaseAgentId,
    env: params.env,
    path: params.destination.path,
  };
  const changed = () =>
    new Error(`Canonical session changed before legacy cleanup: ${params.canonicalKey}`);
  const writer = getOpenClawAgentDatabaseIfOpen(options);
  if (!writer) {
    throw changed();
  }
  const destinationIdentity = readOpenClawAgentDatabaseIdentity(writer).identity;
  const retained = borrowOpenClawAgentDatabase(options);
  let reader: OpenClawAgentReadOnlyDatabaseHandle | undefined;
  try {
    const opened = openOpenClawAgentDatabaseReadOnly(options);
    if (!opened.found) {
      throw changed();
    }
    reader = opened.database;
    const destinationReader = reader;
    const assertCurrent = () => {
      if (
        retained.db !== writer.db ||
        sources.some((claim) => claim.databaseIdentity === destinationIdentity) ||
        getOpenClawAgentDatabaseIfOpen(options) !== writer ||
        !isOpenClawAgentDatabasePathCurrent(writer) ||
        writer.db.isTransaction ||
        !isOpenClawAgentDatabasePathCurrent(destinationReader) ||
        readOpenClawAgentDatabaseIdentity(destinationReader).identity !== destinationIdentity
      ) {
        throw changed();
      }
    };
    let verifiedVersion: number | undefined;
    const assertCopied = () => {
      params.beforePersistentApply?.();
      assertCurrent();
      const version = readSqliteDataVersion(destinationReader.db);
      if (version === verifiedVersion) {
        return;
      }
      if (!hasOpenClawAgentReadOnlySchema(destinationReader)) {
        throw changed();
      }
      const destination = readClaim(
        destinationReader,
        params.destination,
        params.canonicalKey,
        params.canonicalKey,
      );
      if (!destination || !claimUnchanged(destination, params.receipt)) {
        throw changed();
      }
      assertCurrent();
      if (readSqliteDataVersion(destinationReader.db) !== version) {
        throw changed();
      }
      // Only this dedicated reader can reuse its counter; no snapshot survives the assertion.
      verifiedVersion = version;
    };
    assertCopied();
    for (const claim of sources) {
      if (!(await deleteExpectedClaim(claim, assertCopied))) {
        return claim;
      }
    }
    return undefined;
  } finally {
    try {
      reader?.close();
    } finally {
      retained.release();
    }
  }
}

function quarantineClaim(params: {
  beforePersistentApply?: () => void;
  claim: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): Promise<string | undefined> {
  return mutateLegacySessionClaims(
    {
      beforePersistentApply: params.beforePersistentApply,
      store: params.claim.store,
      env: params.env,
      claims: [params.claim],
      operationLabel: "session-migration.legacy-main-quarantine",
    },
    (database) => {
      const fresh = readClaim(
        database,
        params.claim.store,
        params.claim.key,
        params.claim.canonicalKey,
      );
      if (!fresh || !claimUnchanged(fresh, params.claim)) {
        return undefined;
      }
      let quarantineKey: string;
      for (let index = 1; ; index += 1) {
        const candidate = `agent:${params.ownerAgentId}:legacy-main-conflict-${index}`;
        if (!readExactSessionEntryRow(database, candidate)) {
          quarantineKey = candidate;
          break;
        }
      }
      writeMigratedSessionClaim(database, quarantineKey, params.claim.entry);
      deleteLegacySessionEntryRows(database, [params.claim.key], quarantineKey, {
        rehomeMembers: true,
        validatedEntries: new Map([[fresh.key, fresh.entry]]),
      });
      return quarantineKey;
    },
  );
}

export async function processIdenticalClaims(params: {
  beforePersistentApply?: () => void;
  aliases: SessionClaim[];
  canonical?: SessionClaim;
  canonicalKey: string;
  destination: PhysicalStore;
  env: NodeJS.ProcessEnv;
  mode: LegacyMainSessionMigrationMode;
}): Promise<LegacyMainSessionMigrationOutcome> {
  const winner = params.canonical ?? freshestClaim(params.aliases);
  const crossStore = params.aliases.some(
    (claim) => !samePhysicalStore(claim.store, params.destination),
  );
  const completedOutcome = (): LegacyMainSessionMigrationOutcome => ({
    kind: params.canonical
      ? "canonical-exists-identical"
      : crossStore
        ? "migrated-cross-store"
        : "migrated-in-place",
    canonicalKey: params.canonicalKey,
    paths: [...new Set(params.aliases.map((claim) => claim.store.path))],
    sourceKeys: params.aliases.map((claim) => claim.key),
  });
  if (params.mode !== "doctor-fix") {
    return completedOutcome();
  }

  let canonical = params.canonical;
  const destinationAliases = params.aliases.filter((claim) =>
    samePhysicalStore(claim.store, params.destination),
  );
  if (destinationAliases.length > 0) {
    canonical = await migrateClaimsInPlace({
      beforePersistentApply: params.beforePersistentApply,
      aliases: destinationAliases,
      ...(canonical ? { canonical } : {}),
      canonicalKey: params.canonicalKey,
      env: params.env,
      store: params.destination,
      winner: canonical ?? freshestClaim(destinationAliases),
    });
    if (!canonical) {
      return {
        kind: "divergent-aliases",
        canonicalKey: params.canonicalKey,
        detail: "source aliases changed during the in-place transaction",
      };
    }
  }
  for (const sourceBefore of params.aliases) {
    if (samePhysicalStore(sourceBefore.store, params.destination)) {
      continue;
    }
    const copied = await copyClaimCrossStore({
      beforePersistentApply: params.beforePersistentApply,
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      ...(canonical ? { expectedDestination: canonical } : {}),
      env: params.env,
      source: sourceBefore,
    });
    const sourceAfter = withOpenClawAgentDatabaseReadOnly(
      (database) => readClaim(database, sourceBefore.store, sourceBefore.key, params.canonicalKey),
      {
        agentId: sourceBefore.store.databaseAgentId,
        env: params.env,
        path: sourceBefore.store.path,
      },
    );
    if (
      !copied ||
      !claimFullyCopied(sourceBefore, copied) ||
      !sourceAfter.found ||
      !sourceAfter.value ||
      !claimUnchanged(sourceAfter.value, sourceBefore)
    ) {
      return {
        kind: "divergent-canonical",
        canonicalKey: params.canonicalKey,
        detail: "source or imported canonical changed during cross-store copy verification",
      };
    }
    canonical = copied;
  }
  if (!canonical || !claimsMatch(canonical, winner)) {
    return {
      kind: "divergent-canonical",
      canonicalKey: params.canonicalKey,
      detail: "canonical content differs from the legacy claim",
    };
  }

  // The destination commit is durable before source cleanup. Every retry therefore sees either
  // the original claim, an identical canonical claim, or both; no read-through fallback is needed.
  const changedSource = await deleteCopiedClaims({ ...params, receipt: canonical });
  if (changedSource) {
    return {
      kind: "divergent-canonical",
      canonicalKey: params.canonicalKey,
      detail: `source changed before expected-entry cleanup: ${changedSource.store.path}#${changedSource.key}`,
    };
  }
  return completedOutcome();
}

export async function repairDivergentClaims(params: {
  beforePersistentApply?: () => void;
  canonicalKey: string;
  claims: SessionClaim[];
  destination: PhysicalStore;
  destinationCanonical?: SessionClaim;
  env: NodeJS.ProcessEnv;
  ownerAgentId: string;
}): Promise<{ quarantinedKeys: string[]; resolved: boolean }> {
  const winner = params.destinationCanonical ?? freshestClaim(params.claims);
  if (!params.destinationCanonical) {
    const migrated = await processIdenticalClaims({
      beforePersistentApply: params.beforePersistentApply,
      aliases: [winner],
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      mode: "doctor-fix",
    });
    if (migrated.kind === "divergent-aliases" || migrated.kind === "divergent-canonical") {
      return { quarantinedKeys: [], resolved: false };
    }
  }
  const canonicalResult = withOpenClawAgentDatabaseReadOnly(
    (database) => readClaim(database, params.destination, params.canonicalKey, params.canonicalKey),
    {
      agentId: params.destination.databaseAgentId,
      env: params.env,
      path: params.destination.path,
    },
  );
  const canonical = canonicalResult.found ? canonicalResult.value : undefined;
  if (!canonical || !claimsMatch(canonical, winner)) {
    return { quarantinedKeys: [], resolved: false };
  }

  const remaining = params.claims.filter(
    (claim) => claim !== winner && claim !== params.destinationCanonical,
  );
  const identical = remaining.filter((claim) => claimsMatch(claim, canonical));
  if (identical.length > 0) {
    const migrated = await processIdenticalClaims({
      beforePersistentApply: params.beforePersistentApply,
      aliases: identical,
      canonical,
      canonicalKey: params.canonicalKey,
      destination: params.destination,
      env: params.env,
      mode: "doctor-fix",
    });
    if (migrated.kind === "divergent-aliases" || migrated.kind === "divergent-canonical") {
      return { quarantinedKeys: [], resolved: false };
    }
  }
  const quarantinedKeys: string[] = [];
  for (const claim of remaining) {
    if (identical.includes(claim)) {
      continue;
    }
    const quarantineKey = await quarantineClaim({
      beforePersistentApply: params.beforePersistentApply,
      claim,
      env: params.env,
      ownerAgentId: params.ownerAgentId,
    });
    if (!quarantineKey) {
      return { quarantinedKeys, resolved: false };
    }
    quarantinedKeys.push(quarantineKey);
  }
  return { quarantinedKeys, resolved: true };
}

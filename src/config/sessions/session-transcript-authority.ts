import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitReceipt,
  type SqliteCommittedFact,
} from "../../infra/sqlite-commit-receipt.js";
import {
  hasSqlitePostCommitScope,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import {
  sessionChanges,
  sessionRowChangeSource,
  sessionChangeScopeAffectsStoredRows,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { advanceSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readPreparedSessionEntryPublicationSource,
  preparedSharingChanges,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

/** Context postimage; exact anchor membership still belongs to the native projection reader. */
export type SessionTranscriptAuthority = SessionTranscriptContextVersion & {
  sessionId: string;
  sessionKey: string;
  leafEventId: string | null;
  indexedSeq: number | null;
  activeMessageCount: number | null;
  needsRebuild: number | null;
};
export type SessionTranscriptAuthorityReceipt = SqliteCommitReceipt<
  SessionTranscriptAuthority,
  SessionEntryPublicationSource
>;

const staged = resolveGlobalSingleton(
  Symbol.for("openclaw.transcriptAuthorityStaged"),
  () => new WeakMap<DatabaseSync, Map<string, SessionTranscriptAuthorityReceipt>>(),
);
const prepared = resolveGlobalSingleton(
  Symbol.for("openclaw.transcriptAuthorityChanges"),
  () => new WeakMap<object, SqliteCommittedFact<SessionTranscriptAuthority>>(),
);

export function readPreparedSessionTranscriptChange(change: SessionRowChange) {
  return prepared.get(sessionRowChangeSource(change));
}

function receiptChanges(
  receipt: SessionTranscriptAuthorityReceipt,
  agentId: string | undefined,
  storePath: string,
): SessionRowChange[] {
  return [...receipt.facts].map(([sessionKey, fact]) => {
    const change = sessionChanges.markFactsOnly(
      {
        agentId,
        storePath,
        sessionKey,
        scope: "transcript" as const,
        facts: { kind: "unchanged" as const },
      },
      fact.kind === "unchanged" ? undefined : advanceSessionTranscriptUpdateVersion,
    );
    prepared.set(change, fact);
    preparedSharingChanges.changes.set(change, {
      kind: "source",
      databaseIdentity: receipt.source.identity,
      canonicalPath: receipt.source.canonicalPath,
    });
    return change;
  });
}

function publishTranscriptFact(
  database: Pick<OpenClawAgentDatabase, "db" | "path"> & { agentId?: string },
  sessionKey: string,
  fact: SqliteCommittedFact<SessionTranscriptAuthority>,
): void {
  // An unmanaged outer BEGIN has no settlement owner; S5 keeps its native guard.
  if (database.db.isTransaction && !hasSqlitePostCommitScope(database.db)) {
    return;
  }
  const source = findOpenClawAgentDatabaseIdentity(database);
  if (!source) {
    return;
  }
  const receipt = createSqliteCommitReceipt({
    source,
    domain: "session-transcript-context",
    keys: [sessionKey],
    readFact: () => fact,
  });
  const records = staged.get(database.db) ?? new Map<string, SessionTranscriptAuthorityReceipt>();
  const previous = records.get(sessionKey);
  // Content-preserving materialization must not replace an earlier mutation's postimage.
  if (fact.kind === "unchanged" && previous) {
    return;
  }
  const remove = () => {
    if (records.get(sessionKey) === receipt) {
      records.delete(sessionKey);
    }
    if (records.size === 0) {
      staged.delete(database.db);
    }
  };
  stageSqliteTransactionState(database.db, {
    stage() {
      staged.set(database.db, records);
      records.set(sessionKey, receipt);
    },
    commit: remove,
    rollback() {
      if (previous) {
        records.set(sessionKey, previous);
      } else {
        remove();
      }
    },
  });
  sessionChanges.emitBatch(receiptChanges(receipt, database.agentId, database.path), database.db);
}

/** Capture in the existing mutation statement, before COMMIT or savepoint release. */
export function publishSessionTranscriptAuthority(
  database: OpenClawAgentDatabase,
  context: SessionTranscriptAuthority,
): void {
  publishTranscriptFact(database, context.sessionKey, {
    kind: "postimage",
    value: Object.freeze(context),
  });
}

/** Cold materialization and derived-index repair preserve the transcript's content authority. */
export function publishUnchangedSessionTranscriptAuthority(
  database: Pick<OpenClawAgentDatabase, "db" | "path"> & { agentId?: string },
  sessionKey: string,
): void {
  publishTranscriptFact(database, sessionKey, { kind: "unchanged" });
}

export function readStagedSessionTranscriptAuthority(database: { db: DatabaseSync }) {
  const records = staged.get(database.db);
  // Actor-held state stays with its actor; a symbolic owner cannot become a file receipt.
  const transferable = [...(records?.values() ?? [])].filter(
    (receipt) => typeof receipt.source.identity === "string",
  );
  return transferable.length ? transferable : undefined;
}

/** A following entry write consumes the transcript owner's staged watermark. */
export function readStagedSessionTranscriptUpdatedAt(
  database: { db: DatabaseSync },
  sessionId: string,
): number | undefined {
  let updatedAt: number | undefined;
  for (const receipt of readStagedSessionTranscriptAuthority(database) ?? []) {
    for (const fact of receipt.facts.values()) {
      if (
        fact.kind === "postimage" &&
        fact.value.sessionId === sessionId &&
        fact.value.updatedAt !== null
      ) {
        updatedAt = Math.max(updatedAt ?? 0, fact.value.updatedAt);
      }
    }
  }
  return updatedAt;
}

export function parseSessionTranscriptAuthorityReceipts(
  value: unknown,
): readonly SessionTranscriptAuthorityReceipt[] | undefined {
  return Array.isArray(value) && value.every(isTranscriptReceipt) ? value : undefined;
}

/** Confirmed content-preserving operations cannot install or restore a context postimage. */
export function publishUnchangedSessionTranscriptReceipts(
  receipts: readonly SessionTranscriptAuthorityReceipt[] | undefined,
): void {
  if (!receipts) {
    return;
  }
  if (
    !parseSessionTranscriptAuthorityReceipts(receipts) ||
    receipts.some((receipt) =>
      [...receipt.facts.values()].some((fact) => fact.kind !== "unchanged"),
    )
  ) {
    throw new Error("Transcript materialization changed its content authority receipt");
  }
  sessionChanges.emitBatch(
    receipts.flatMap((receipt) =>
      receiptChanges(receipt, undefined, receipt.source.canonicalPath ?? receipt.source.filename),
    ),
  );
}

function isTranscriptReceipt(value: unknown): value is SessionTranscriptAuthorityReceipt {
  if (!isRecord(value) || !isRecord(value.source) || !(value.facts instanceof Map)) {
    return false;
  }
  const keys = [...value.facts.keys()];
  if (
    !keys.every((key) => typeof key === "string") ||
    typeof value.source.identity !== "string" ||
    typeof value.source.incarnation !== "string"
  ) {
    return false;
  }
  if (
    !hasSqliteCommitReceiptCoverage(value, {
      source: { identity: value.source.identity, incarnation: value.source.incarnation },
      domain: "session-transcript-context",
      keys,
    })
  ) {
    return false;
  }
  const nullableNumber = (number: unknown) =>
    number === null || (typeof number === "number" && Number.isSafeInteger(number));
  for (const [key, fact] of value.facts) {
    if (!isRecord(fact)) {
      return false;
    }
    if (fact.kind !== "postimage") {
      continue;
    }
    const row = fact.value;
    if (
      !isRecord(row) ||
      row.sessionKey !== key ||
      typeof row.sessionId !== "string" ||
      (row.generation !== null && typeof row.generation !== "string") ||
      (row.leafEventId !== null && typeof row.leafEventId !== "string") ||
      ![row.rawSeq, row.updatedAt, row.indexedSeq, row.activeMessageCount].every(nullableNumber) ||
      (row.needsRebuild !== null && row.needsRebuild !== 0 && row.needsRebuild !== 1)
    ) {
      return false;
    }
  }
  return true;
}

/** Only pending operations retain supersession state; committed facts use the session owner. */
export function retainSessionTranscriptWorkerPublication(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
}) {
  let receipts: readonly SessionTranscriptAuthorityReceipt[] = [];
  const superseded = new Set<string>();
  let stop: (() => void) | undefined;
  return {
    begin(value: readonly SessionTranscriptAuthorityReceipt[] | undefined) {
      if (value && (!Array.isArray(value) || !value.every(isTranscriptReceipt))) {
        throw new Error("Transcript worker omitted its authority postimage");
      }
      receipts = value ?? [];
      superseded.clear();
      stop?.();
      stop = receipts.length
        ? sessionChanges.subscribeFacts((change) => {
            if (!sessionChangeScopeAffectsStoredRows(change)) {
              return;
            }
            const source = readPreparedSessionEntryPublicationSource(change);
            if (source.identity !== undefined && source.identity !== params.databaseIdentity) {
              return;
            }
            if (source.identity === undefined) {
              const scope = "all" in change ? change.scope : change;
              if (
                typeof scope === "object" &&
                ((scope.storePath && scope.storePath !== params.storePath) ||
                  (scope.agentId && scope.agentId !== params.agentId))
              ) {
                return;
              }
            }
            const transcript = readPreparedSessionTranscriptChange(change);
            // Materialization preserves content and cannot replace a delayed mutation postimage.
            if (!change.factsInvalidated && transcript?.kind === "unchanged") {
              return;
            }
            // Only a later transcript publication or identity revocation supersedes this domain.
            if (
              !transcript &&
              "sessionKey" in change &&
              change.facts?.kind !== "removed" &&
              !(
                (change.facts?.kind === "entry" || change.facts?.kind === "replacement") &&
                change.facts.lifecycleChanged
              ) &&
              !change.factsInvalidated
            ) {
              return;
            }
            for (const receipt of receipts) {
              for (const key of receipt.facts.keys()) {
                if ("all" in change || change.sessionKey === key) {
                  superseded.add(key);
                }
              }
            }
          })
        : undefined;
    },
    settle(
      committed: boolean,
      outcomeUnknown: boolean,
      confirmation: unknown = receipts,
    ): SessionRowChange[] {
      const unknown = outcomeUnknown || (committed && !isDeepStrictEqual(receipts, confirmation));
      stop?.();
      stop = undefined;
      const changes: SessionRowChange[] = [];
      for (const receipt of receipts) {
        const valid = receipt.source.identity === params.databaseIdentity;
        for (const [key, fact] of receipt.facts) {
          if (superseded.has(key)) {
            continue;
          }
          const installed =
            committed && !unknown && valid
              ? fact
              : unknown || !valid
                ? { kind: "unknown" as const }
                : undefined;
          if (installed) {
            changes.push(
              ...receiptChanges(
                { ...receipt, facts: new Map([[key, installed]]) },
                params.agentId,
                params.storePath,
              ),
            );
          }
        }
      }
      receipts = [];
      return changes;
    },
  };
}

/**
 * A destructive commit cannot be undone by restoring bytes while a consumer awaits.
 * This latch only refuses; final acceptance still joins the owner FIFO and validates
 * exact anchors with its native mutation witness, including pending worker writes.
 */
export function retainSessionTranscriptContextGeneration(
  params: { agentId?: string; sessionKey: string; sessionId: string; storePath?: string },
  version: SessionTranscriptContextVersion | undefined,
  databaseIdentity?: string,
) {
  let revoked = false;
  const release = sessionChanges.subscribeFacts((change) => {
    const source = readPreparedSessionEntryPublicationSource(change);
    if (databaseIdentity && source.identity && source.identity !== databaseIdentity) {
      return;
    }
    if ("all" in change) {
      if (
        source.identity === undefined &&
        typeof change.scope !== "string" &&
        change.scope.storePath &&
        params.storePath &&
        change.scope.storePath !== params.storePath
      ) {
        return;
      }
      if (
        typeof change.scope !== "string" &&
        change.scope.agentId &&
        params.agentId &&
        change.scope.agentId !== params.agentId
      ) {
        return;
      }
      if (
        change.factsInvalidated ||
        change.scope === "stores" ||
        (typeof change.scope !== "string" && change.scope.topology)
      ) {
        revoked = true;
      }
      return;
    }
    if (
      change.sessionKey !== params.sessionKey ||
      (change.agentId && params.agentId && change.agentId !== params.agentId) ||
      (source.identity === undefined &&
        change.storePath &&
        params.storePath &&
        change.storePath !== params.storePath)
    ) {
      return;
    }
    if (
      change.factsInvalidated === true ||
      change.facts?.kind === "removed" ||
      ((change.facts?.kind === "entry" || change.facts?.kind === "replacement") &&
        change.facts.lifecycleChanged) ||
      (change.facts?.kind === "entry" && change.facts.sessionId !== params.sessionId)
    ) {
      revoked = true;
    }
    const fact = readPreparedSessionTranscriptChange(change);
    if (fact?.kind === "unknown" || fact?.kind === "absent") {
      revoked = true;
    }
    if (
      fact?.kind === "postimage" &&
      fact.value.sessionId === params.sessionId &&
      version &&
      fact.value.generation !== version.generation
    ) {
      revoked = true;
    }
  });
  return {
    release,
    assertCurrent() {
      if (revoked) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
    },
  };
}

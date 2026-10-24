import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSessionRowAssistantMessage } from "../../gateway/session-row-transcript-preview.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
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
import { isSessionTranscriptTerminalModel } from "../../sessions/transcript-terminal-model.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readPreparedSessionEntryPublicationSource,
  preparedSharingChanges,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { prepareSessionActorTranscriptAuthority } from "./session-actor-transaction.js";
import type {
  SessionTranscriptAuthority,
  SessionTranscriptAuthorityReceipt,
} from "./session-transcript-authority.types.js";

const staged = resolveGlobalSingleton(
  Symbol.for("openclaw.transcriptAuthorityStaged"),
  () => new WeakMap<EngineConnection, Map<string, SessionTranscriptAuthorityReceipt>>(),
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
  let preparedContext = context;
  if (context.lastAssistantMessage === "unchanged") {
    const previous = staged
      .get(database.db)
      ?.get(context.sessionKey)
      ?.facts.get(context.sessionKey);
    // A turn can append several messages before its one committed receipt is published.
    if (previous?.kind === "postimage" && previous.value.sessionId === context.sessionId) {
      preparedContext = {
        ...context,
        lastAssistantMessage:
          previous.value.lastAssistantMessage === undefined
            ? "unknown"
            : previous.value.lastAssistantMessage,
      };
    }
  }
  publishTranscriptFact(database, context.sessionKey, {
    kind: "postimage",
    value: Object.freeze(prepareSessionActorTranscriptAuthority(database, preparedContext)),
  });
}

/** Cold materialization and derived-index repair preserve the transcript's content authority. */
export function publishUnchangedSessionTranscriptAuthority(
  database: Pick<OpenClawAgentDatabase, "db" | "path"> & { agentId?: string },
  sessionKey: string,
): void {
  publishTranscriptFact(database, sessionKey, { kind: "unchanged" });
}

export function readStagedSessionTranscriptAuthority(database: { db: EngineConnection }) {
  const records = staged.get(database.db);
  // Actor-held state stays with its actor; a symbolic owner cannot become a file receipt.
  const transferable = [...(records?.values() ?? [])].filter(
    (receipt) => typeof receipt.source.identity === "string",
  );
  return transferable.length ? transferable : undefined;
}

/** A following entry write consumes the transcript owner's staged watermark. */
export function readStagedSessionTranscriptUpdatedAt(
  database: { db: EngineConnection },
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
  publishCommittedSessionTranscriptReceipts(receipts);
}

/** The native settlement owner publishes these while it still holds the writer FIFO. */
export function publishCommittedSessionTranscriptReceipts(
  receipts: readonly SessionTranscriptAuthorityReceipt[] | undefined,
): void {
  sessionChanges.emitBatch(
    (receipts ?? []).flatMap((receipt) =>
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
      (row.needsRebuild !== null && row.needsRebuild !== 0 && row.needsRebuild !== 1) ||
      (row.lastMessagePreview !== undefined &&
        row.lastMessagePreview !== null &&
        typeof row.lastMessagePreview !== "string") ||
      (row.lastAssistantMessage !== undefined &&
        row.lastAssistantMessage !== null &&
        row.lastAssistantMessage !== "unknown" &&
        row.lastAssistantMessage !== "unchanged" &&
        !isSessionRowAssistantMessage(row.lastAssistantMessage)) ||
      (row.terminalModel !== undefined &&
        row.terminalModel !== null &&
        !isSessionTranscriptTerminalModel(row.terminalModel))
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

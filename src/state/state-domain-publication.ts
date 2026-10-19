import { randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import {
  createSqliteCommitReceipt,
  readSqliteCommitReceipt,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
  type SqliteCommittedFact,
} from "../infra/sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
  type SqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";

export type StateDomainChange<T> =
  | { kind: "committed"; receipt: SqliteCommitReceipt<T> }
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending" | "settled"; identity: string | symbol; operationId: string };

const batch = resolveGlobalSingleton<{ current: SqliteCommittedPublication[] | undefined }>(
  Symbol.for("openclaw.stateDomainPublicationBatch"),
  () => ({ current: undefined }),
);

/** Compose the domains of one committed operation before any public observer runs. */
export function batchStateDomainPublications(operation: () => void): void {
  if (batch.current) {
    operation();
    return;
  }
  const publications: SqliteCommittedPublication[] = [];
  batch.current = publications;
  try {
    operation();
  } finally {
    batch.current = undefined;
    publishSqliteCommittedState(publications);
  }
}

/** Shared staging mechanics only; domain owners retain projections and authority. */
export function createStateDomainPublication<T>(codec: {
  domain: string;
  sourceIdentity?(this: void, db: EngineConnection): string | symbol;
  keyOf(value: T): string;
  isValue(value: unknown): value is T;
}) {
  const publication = createKeyedStateDomainPublication<T>({
    domain: codec.domain,
    sourceIdentity: codec.sourceIdentity,
    isFact: (key, fact) =>
      fact.kind === "absent" ||
      (fact.kind === "postimage" && codec.isValue(fact.value) && codec.keyOf(fact.value) === key),
  });
  return {
    ...publication,
    stagePostimages(db: EngineConnection, values: readonly T[]) {
      publication.stagePostimages(
        db,
        values.map((value) => [codec.keyOf(value), value]),
      );
    },
  };
}

/** Domains with compound keys keep their key policy outside the shared receipt lifecycle. */
export function createKeyedStateDomainPublication<T>(codec: {
  domain: string;
  sourceIdentity?(this: void, db: EngineConnection): string | symbol;
  isFact(this: void, key: string, fact: SqliteCommittedFact<unknown>): boolean;
  invalidReceiptMessage?: string;
  installFailureMessage?: string;
  mutationDuringInstallMessage?: string;
  closedMessage?: string;
  changedOwnerMessage?: string;
}) {
  type Receipt = SqliteCommitReceipt<T>;
  type Facts = Map<string, SqliteCommittedFact<T>>;
  type Capture = { db: EngineConnection; facts: Facts };
  const state = resolveGlobalSingleton<{
    sources: WeakMap<EngineConnection, SqliteCommitSource>;
    capture?: Capture;
    facts: Set<(change: StateDomainChange<T>) => void>;
    observers: Set<(change: StateDomainChange<T>) => void>;
    installingFacts: number;
  }>(Symbol.for(`openclaw.stateDomainPublication.${codec.domain}`), () => ({
    sources: new WeakMap<EngineConnection, SqliteCommitSource>(),
    facts: new Set<(change: StateDomainChange<T>) => void>(),
    observers: new Set<(change: StateDomainChange<T>) => void>(),
    installingFacts: 0,
  }));
  const sourceFor = (db: EngineConnection) => {
    const anchor = sqlPublicationAnchor(db);
    let source = state.sources.get(anchor);
    if (!source) {
      source = {
        identity:
          codec.sourceIdentity?.(db) ??
          readTrackedStateDatabaseIdentity(db)?.key ??
          Symbol(codec.domain),
        incarnation: randomUUID(),
      };
      state.sources.set(anchor, source);
    }
    return source;
  };
  const receiptFor = (
    db: EngineConnection,
    facts: ReadonlyMap<string, SqliteCommittedFact<T>>,
  ): Receipt =>
    createSqliteCommitReceipt({
      source: sourceFor(db),
      domain: codec.domain,
      keys: [...facts.keys()],
      readFact: (key) => facts.get(key)!,
    });
  const install = (change: StateDomainChange<T>) => {
    const errors: unknown[] = [];
    state.installingFacts++;
    try {
      notifyListeners(state.facts, change, (error) => errors.push(error));
    } finally {
      state.installingFacts--;
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        codec.installFailureMessage ?? "State domain fact installation failed",
      );
    }
  };
  const publication = (receipt: Receipt) => {
    let change: StateDomainChange<T> = { kind: "committed", receipt };
    return {
      installFacts: () => install(change),
      invalidate() {
        change = { kind: "unknown", identity: receipt.source.identity };
        install(change);
      },
      notify: () => notifyListeners(state.observers, change),
    };
  };
  const stage = (db: EngineConnection, facts: Facts) => {
    if (codec.mutationDuringInstallMessage && state.installingFacts) {
      throw new Error(codec.mutationDuringInstallMessage);
    }
    if (!facts.size) {
      return;
    }
    const capture = state.capture;
    if (capture && sqlPublicationAnchor(capture.db) === sqlPublicationAnchor(db)) {
      const previous = new Map([...facts.keys()].map((key) => [key, capture.facts.get(key)]));
      if (
        !stageSqliteTransactionState(db, {
          stage() {
            for (const [key, fact] of facts) {
              capture.facts.set(key, fact);
            }
          },
          commit() {},
          rollback() {
            for (const [key, fact] of previous) {
              if (fact) {
                capture.facts.set(key, fact);
              } else {
                capture.facts.delete(key);
              }
            }
          },
        })
      ) {
        throw new Error("State domain capture requires its owning transaction");
      }
    }
    const next = publication(receiptFor(db, facts));
    if (!stageSqliteCommittedPublication(db, next) && !db.isTransaction) {
      publishSqliteCommittedState(next);
    }
  };
  const readReceipt = (value: unknown, isFact = codec.isFact): Receipt =>
    readSqliteCommitReceipt<T>(value, {
      domain: codec.domain,
      isFact,
      invalidReceiptMessage: codec.invalidReceiptMessage,
    });
  return {
    receipt: receiptFor,
    readReceipt,
    stageFacts: stage,
    stagePostimages(db: EngineConnection, entries: readonly (readonly [string, T])[]) {
      stage(
        db,
        new Map(
          entries.map(([key, value]) => [
            key,
            { kind: "postimage", value: structuredClone(value) },
          ]),
        ),
      );
    },
    stageDeletions(db: EngineConnection, keys: readonly string[]) {
      stage(db, new Map(keys.map((key) => [key, { kind: "absent" }])));
    },
    capture<Result>(db: EngineConnection, operation: () => Result) {
      const parent = state.capture;
      const capture: Capture =
        parent && sqlPublicationAnchor(parent.db) === sqlPublicationAnchor(db)
          ? parent
          : { db, facts: new Map() };
      // Captures produce their receipt inside a synchronous transaction callback.
      state.capture = capture;
      try {
        const result = operation();
        return { result, receipt: receiptFor(db, capture.facts) };
      } finally {
        state.capture = parent;
      }
    },
    /** Leave space for sibling domains and the operation's existing settlement metadata. */
    bound(receipt: Receipt): Receipt | { kind: "unknown"; identity: string | symbol } {
      return serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES / 4
        ? receipt
        : { kind: "unknown", identity: receipt.source.identity };
    },
    subscribeFacts: (listener: (change: StateDomainChange<T>) => void) =>
      registerListener(state.facts, listener),
    subscribe: (listener: (change: StateDomainChange<T>) => void) =>
      registerListener(state.observers, listener),
    begin(
      owner: { identity: string | symbol; assertCurrent(): void; publishPending?: boolean },
      isFact = codec.isFact,
    ) {
      const operationId = randomUUID();
      const superseded = new Set<string>();
      let installing = false;
      let unknown = false;
      let received = false;
      let finished = false;
      const unsubscribe = registerListener(state.facts, (change) => {
        if (installing) {
          return;
        }
        if (change.kind === "committed" && change.receipt.source.identity === owner.identity) {
          for (const key of change.receipt.facts.keys()) {
            superseded.add(key);
          }
        } else if (change.kind === "unknown" && change.identity === owner.identity) {
          unknown = true;
        }
      });
      try {
        if (owner.publishPending !== false) {
          install({ kind: "pending", identity: owner.identity, operationId });
        }
      } catch (error) {
        unsubscribe();
        try {
          install({ kind: "settled", identity: owner.identity, operationId });
        } catch {
          // The writer never started; preserve the original observer failure.
        }
        throw error;
      }
      return {
        committed(this: void, value: unknown, publish?: () => void) {
          try {
            owner.assertCurrent();
            if (finished) {
              throw new Error(codec.closedMessage ?? "State domain publication owner is closed");
            }
            if (isRecord(value) && value.kind === "unknown" && value.identity === owner.identity) {
              install({ kind: "unknown", identity: owner.identity });
            } else {
              const receipt = readReceipt(value, isFact);
              if (receipt.source.identity !== owner.identity) {
                throw new Error(
                  codec.changedOwnerMessage ?? "State domain commit receipt changed owner",
                );
              }
              const next = publication({
                ...receipt,
                facts: new Map(
                  [...receipt.facts].map(([key, fact]) => [
                    key,
                    unknown || superseded.has(key) ? { kind: "unknown" } : fact,
                  ]),
                ),
              });
              const queued = {
                ...next,
                installFacts() {
                  installing = true;
                  try {
                    next.installFacts();
                  } finally {
                    installing = false;
                  }
                },
              };
              if (batch.current) {
                batch.current.push(queued);
              } else {
                publishSqliteCommittedState(queued);
              }
            }
            received = true;
            publish?.();
          } catch (error) {
            install({ kind: "unknown", identity: owner.identity });
            throw error;
          } finally {
            installing = false;
          }
        },
        /** A confirmed rollback preserves prior facts; a missing accepted receipt does not. */
        finish(confirmed: boolean, rolledBack = false) {
          if (finished) {
            return;
          }
          finished = true;
          unsubscribe();
          try {
            if (!confirmed || (!received && !rolledBack)) {
              install({ kind: "unknown", identity: owner.identity });
            }
          } finally {
            if (owner.publishPending !== false) {
              install({ kind: "settled", identity: owner.identity, operationId });
            }
          }
        },
      };
    },
  };
}

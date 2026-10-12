import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
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
  keyOf(value: T): string;
  isValue(value: unknown): value is T;
}) {
  const publication = createKeyedStateDomainPublication<T>({
    domain: codec.domain,
    isFact: (key, fact) =>
      fact.kind === "absent" ||
      (fact.kind === "postimage" && codec.isValue(fact.value) && codec.keyOf(fact.value) === key),
  });
  return {
    ...publication,
    stagePostimages(db: DatabaseSync, values: readonly T[]) {
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
  isFact(this: void, key: string, fact: SqliteCommittedFact<unknown>): boolean;
  invalidReceiptMessage?: string;
  installFailureMessage?: string;
}) {
  type Receipt = SqliteCommitReceipt<T>;
  type Facts = Map<string, SqliteCommittedFact<T>>;
  const state = resolveGlobalSingleton(
    Symbol.for(`openclaw.stateDomainPublication.${codec.domain}`),
    () => ({
      sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
      capture: new AsyncLocalStorage<{ db: DatabaseSync; facts: Facts }>(),
      facts: new Set<(change: StateDomainChange<T>) => void>(),
      observers: new Set<(change: StateDomainChange<T>) => void>(),
    }),
  );
  const sourceFor = (db: DatabaseSync) => {
    let source = state.sources.get(db);
    if (!source) {
      source = {
        identity: readTrackedStateDatabaseIdentity(db)?.key ?? Symbol(codec.domain),
        incarnation: randomUUID(),
      };
      state.sources.set(db, source);
    }
    return source;
  };
  const receiptFor = (
    db: DatabaseSync,
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
    notifyListeners(state.facts, change, (error) => errors.push(error));
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
  const stage = (db: DatabaseSync, facts: Facts) => {
    if (!facts.size) {
      return;
    }
    const capture = state.capture.getStore();
    if (capture?.db === db) {
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
  const readReceipt = (value: unknown, isFact = codec.isFact): Receipt => {
    if (
      !isRecord(value) ||
      !isRecord(value.source) ||
      typeof value.source.identity !== "string" ||
      typeof value.source.incarnation !== "string" ||
      !(value.facts instanceof Map) ||
      !hasSqliteCommitReceiptCoverage(value, {
        source: { identity: value.source.identity, incarnation: value.source.incarnation },
        domain: codec.domain,
        keys: [...value.facts.keys()],
      }) ||
      ![...value.facts].every(([key, fact]) => typeof key === "string" && isFact(key, fact))
    ) {
      throw new Error(codec.invalidReceiptMessage ?? "State domain commit receipt is invalid");
    }
    // SAFETY: The envelope, domain, keys, and every postimage were validated above.
    return value as Receipt;
  };
  return {
    receipt: receiptFor,
    stagePostimages(db: DatabaseSync, entries: readonly (readonly [string, T])[]) {
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
    stageDeletions(db: DatabaseSync, keys: readonly string[]) {
      stage(db, new Map(keys.map((key) => [key, { kind: "absent" }])));
    },
    capture<Result>(db: DatabaseSync, operation: () => Result) {
      const parent = state.capture.getStore();
      return state.capture.run(parent?.db === db ? parent : { db, facts: new Map() }, () => {
        const result = operation();
        return { result, receipt: receiptFor(db, state.capture.getStore()!.facts) };
      });
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
    begin(owner: { identity: string | symbol; assertCurrent(): void }, isFact = codec.isFact) {
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
        install({ kind: "pending", identity: owner.identity, operationId });
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return {
        committed(value: unknown, publish?: () => void) {
          try {
            owner.assertCurrent();
            if (finished) {
              throw new Error("State domain publication owner is closed");
            }
            if (isRecord(value) && value.kind === "unknown" && value.identity === owner.identity) {
              install({ kind: "unknown", identity: owner.identity });
            } else {
              const receipt = readReceipt(value, isFact);
              if (receipt.source.identity !== owner.identity) {
                throw new Error("State domain commit receipt changed owner");
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
            install({ kind: "settled", identity: owner.identity, operationId });
          }
        },
      };
    },
  };
}

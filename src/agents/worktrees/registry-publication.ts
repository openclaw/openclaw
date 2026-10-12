import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
  type SqliteCommittedFact,
} from "../../infra/sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

type RegistryRow = Selectable<DB["worktrees"]>;
type LeaseRow = Selectable<DB["state_leases"]>;
type RegistryFact = RegistryRow | LeaseRow;
type Receipt = SqliteCommitReceipt<RegistryFact>;
type Change =
  | { kind: "committed"; receipt: Receipt }
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending" | "settled"; identity: string; operation: object };
type WorkerReceipt<T = unknown> = {
  publication: Receipt | { kind: "unknown"; identity: string | symbol };
  result: { kind: "known"; value: T } | { kind: "unknown" };
  receipt?: string;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.worktreeRegistryPublication"), () => ({
  sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
  capture: new AsyncLocalStorage<Map<string, SqliteCommittedFact<RegistryFact>>>(),
  facts: new Set<(change: Change) => void>(),
  installing: false,
}));

function sourceFor(db: DatabaseSync): SqliteCommitSource {
  let source = state.sources.get(db);
  if (!source) {
    source = {
      identity: readTrackedStateDatabaseIdentity(db)?.key ?? Symbol("untracked-worktree-registry"),
      incarnation: randomUUID(),
    };
    state.sources.set(db, source);
  }
  return source;
}

function keyFor(row: Pick<RegistryRow, "id"> | Pick<LeaseRow, "scope" | "lease_key">): string {
  return "id" in row
    ? JSON.stringify(["worktrees", row.id])
    : JSON.stringify(["state_leases", row.scope, row.lease_key]);
}

function captureReceipt(
  db: DatabaseSync,
  facts: ReadonlyMap<string, SqliteCommittedFact<RegistryFact>>,
) {
  return createSqliteCommitReceipt({
    source: sourceFor(db),
    domain: "worktree-registry",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
}

function install(change: Change) {
  const failures: unknown[] = [];
  state.installing = true;
  try {
    notifyListeners(state.facts, change, (error) => failures.push(error));
  } finally {
    state.installing = false;
  }
  if (failures.length) {
    throw new AggregateError(failures, "Worktree registry fact installation failed");
  }
}

function publication(receipt: Receipt) {
  let change: Change = { kind: "committed", receipt };
  return {
    installFacts: () => install(change),
    invalidate() {
      change = { kind: "unknown", identity: receipt.source.identity };
      install(change);
    },
    notify() {},
  };
}

/** Exact owner-written rows only; raw writes and protecting session/placement sets remain separate. */
export const worktreeRegistryPublication = {
  subscribeFacts: (listener: (change: Change) => void) => registerListener(state.facts, listener),
  rows(db: DatabaseSync, rows: readonly RegistryFact[]) {
    stage(db, new Map(rows.map((row) => [keyFor(row), { kind: "postimage", value: { ...row } }])));
  },
  deleted(
    db: DatabaseSync,
    rows: readonly (RegistryRow | Pick<LeaseRow, "scope" | "lease_key">)[],
  ) {
    stage(db, new Map(rows.map((row) => [keyFor(row), { kind: "absent" }])));
  },
};

function stage(db: DatabaseSync, facts: Map<string, SqliteCommittedFact<RegistryFact>>) {
  if (!facts.size) {
    return;
  }
  if (state.installing) {
    throw new Error("Worktree registry cannot mutate during fact installation");
  }
  const capture = state.capture.getStore();
  if (capture) {
    const previous = new Map([...facts.keys()].map((key) => [key, capture.get(key)]));
    stageSqliteTransactionState(db, {
      stage: () => facts.forEach((fact, key) => capture.set(key, fact)),
      commit() {},
      rollback: () =>
        previous.forEach((fact, key) => (fact ? capture.set(key, fact) : capture.delete(key))),
    });
  }
  const next = publication(captureReceipt(db, facts));
  if (!stageSqliteCommittedPublication(db, next) && !db.isTransaction) {
    publishSqliteCommittedState(next);
  }
}

/** The result and existing operation token survive ordinary reply loss without replaying the write. */
export function withWorktreeRegistryWorkerReceipt<T>(
  db: DatabaseSync,
  write: () => T,
  receipt?: string,
): T {
  return state.capture.run(new Map(), () => {
    const result = write();
    const facts = state.capture.getStore()!;
    const committed = captureReceipt(db, facts);
    const payload: WorkerReceipt<T> = {
      receipt,
      result: { kind: "known", value: result },
      publication: committed,
    };
    if (serialize(payload).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
      payload.publication = { kind: "unknown", identity: committed.source.identity };
      if (serialize(payload).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
        // Preserve native COMMIT evidence even when its result needs ordinary chunked delivery.
        payload.result = { kind: "unknown" };
      }
    }
    deferSqliteWorkerCommitReceipt(db, payload, facts.size ? "commit" : "settlement");
    return result;
  });
}

export function readWorktreeRegistryWorkerReceipt(value: unknown): WorkerReceipt | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    !isRecord(value.publication) ||
    (value.receipt !== undefined && typeof value.receipt !== "string") ||
    (value.result.kind !== "unknown" &&
      !(value.result.kind === "known" && Object.hasOwn(value.result, "value")))
  ) {
    return undefined;
  }
  const receipt = value.publication;
  const result: WorkerReceipt["result"] =
    value.result.kind === "known"
      ? { kind: "known", value: value.result.value }
      : { kind: "unknown" };
  if (receipt.kind === "unknown" && typeof receipt.identity === "string") {
    return {
      publication: { kind: "unknown", identity: receipt.identity },
      result,
      receipt: value.receipt,
    };
  }
  if (
    !isRecord(receipt.source) ||
    typeof receipt.source.identity !== "string" ||
    typeof receipt.source.incarnation !== "string" ||
    !(receipt.facts instanceof Map) ||
    !hasSqliteCommitReceiptCoverage(receipt, {
      source: { identity: receipt.source.identity, incarnation: receipt.source.incarnation },
      domain: "worktree-registry",
      keys: [...receipt.facts.keys()],
    }) ||
    ![...receipt.facts].every(([key, fact]) => {
      if (typeof key !== "string") {
        return false;
      }
      if (fact.kind === "absent") {
        return true;
      }
      if (fact.kind !== "postimage" || !isRecord(fact.value)) {
        return false;
      }
      const row = fact.value;
      return typeof row.id === "string"
        ? keyFor({ id: row.id }) === key
        : typeof row.scope === "string" &&
            typeof row.lease_key === "string" &&
            keyFor({ scope: row.scope, lease_key: row.lease_key }) === key;
    })
  ) {
    return undefined;
  }
  // SAFETY: This private worker owns the SQL row shape; the version, source, facts, and exact keys were checked above.
  return { publication: receipt as Receipt, result, receipt: value.receipt };
}

export function withWorktreeRegistryPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    const identity = () => context.admission.identity.key;
    const superseded = new Set<string>();
    let installing = false;
    let unknown = false;
    let received = false;
    const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if (change.kind === "committed" && change.receipt.source.identity === identity()) {
        change.receipt.facts.forEach((_fact, key) => superseded.add(key));
      } else if (change.kind === "unknown" && change.identity === identity()) {
        unknown = true;
      }
    });
    const finish = owner.admission.finish.bind(owner.admission);
    let finished = false;
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        if (!finished) {
          finished = true;
          unsubscribe();
          if (!received || owner.admission.settlement?.kind !== "completed") {
            install({ kind: "unknown", identity: identity() });
          }
          install({ kind: "settled", identity: identity(), operation });
        }
      }
    };
    try {
      install({ kind: "pending", identity: identity(), operation });
    } catch (error) {
      owner.admission.finish();
      throw error;
    }
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      const committed = readWorktreeRegistryWorkerReceipt(facts);
      if (!committed) {
        throw new Error("Worktree registry receipt is invalid");
      }
      (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
      const receipt = committed.publication;
      const source = "kind" in receipt ? receipt.identity : receipt.source.identity;
      if (source !== identity()) {
        throw new Error("Worktree registry receipt changed owner");
      }
      installing = true;
      try {
        if ("kind" in receipt) {
          install(receipt);
        } else {
          publishSqliteCommittedState(
            publication({
              ...receipt,
              facts: new Map(
                [...receipt.facts].map(([key, fact]) => [
                  key,
                  unknown || superseded.has(key) ? { kind: "unknown" } : fact,
                ]),
              ),
            }),
          );
        }
        received = true;
      } finally {
        installing = false;
      }
    });
    return owner;
  };
}

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
} from "../infra/sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "../state/openclaw-state-db-handle.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

type PluginStateRow = Selectable<DB["plugin_state_entries"]>;
type EntryKey = Pick<PluginStateRow, "plugin_id" | "namespace" | "entry_key">;
type Receipt = SqliteCommitReceipt<PluginStateRow>;
type PluginStateChange =
  | { kind: "committed"; receipt: Receipt }
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending" | "settled"; identity: string | symbol; operationId: string };

const state = resolveGlobalSingleton(Symbol.for("openclaw.pluginStatePublication"), () => ({
  sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
  capture: new AsyncLocalStorage<Map<string, SqliteCommittedFact<PluginStateRow>>>(),
  installingFacts: 0,
  facts: new Set<(change: PluginStateChange) => void>(),
  observers: new Set<(change: PluginStateChange) => void>(),
}));

function sourceFor(db: DatabaseSync): SqliteCommitSource {
  let source = state.sources.get(db);
  if (!source) {
    source = {
      identity: readTrackedStateDatabaseIdentity(db)?.key ?? Symbol("untracked-plugin-state"),
      incarnation: randomUUID(),
    };
    state.sources.set(db, source);
  }
  return source;
}

function keyFor(row: EntryKey): string {
  return JSON.stringify([row.plugin_id, row.namespace, row.entry_key]);
}

function captureReceipt(
  db: DatabaseSync,
  facts: ReadonlyMap<string, SqliteCommittedFact<PluginStateRow>>,
) {
  return createSqliteCommitReceipt({
    source: sourceFor(db),
    domain: "plugin-state",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
}

function install(change: PluginStateChange): void {
  const errors: unknown[] = [];
  state.installingFacts++;
  try {
    notifyListeners(state.facts, change, (error) => errors.push(error));
  } finally {
    state.installingFacts--;
  }
  if (errors.length) {
    throw new AggregateError(errors, "Plugin state fact installation failed");
  }
}

function publication(receipt: Receipt) {
  let change: PluginStateChange = { kind: "committed", receipt };
  return {
    installFacts: () => install(change),
    invalidate() {
      change = { kind: "unknown", identity: receipt.source.identity };
      install(change);
    },
    notify: () => notifyListeners(state.observers, change),
  };
}

/** Owns committed-fact staging and observation; raw/foreign authority remains separate. */
export const pluginStatePublication = {
  stagePostimage: stagePluginStatePostimage,
  stageDeletions: stagePluginStateDeletions,
  /** Install/invalidate prepared facts only; storage mutations belong in postcommit observers. */
  subscribeFacts: (listener: (change: PluginStateChange) => void) =>
    registerListener(state.facts, listener),
  subscribe: (listener: (change: PluginStateChange) => void) =>
    registerListener(state.observers, listener),
};

function stage(db: DatabaseSync, facts: Map<string, SqliteCommittedFact<PluginStateRow>>) {
  if (!facts.size) {
    return;
  }
  if (state.installingFacts) {
    throw new Error("Plugin state cannot mutate during fact installation");
  }
  const capture = state.capture.getStore();
  if (capture) {
    const previous = new Map([...facts.keys()].map((key) => [key, capture.get(key)]));
    stageSqliteTransactionState(db, {
      stage: () => {
        for (const [key, fact] of facts) {
          capture.set(key, fact);
        }
      },
      commit() {},
      rollback: () => {
        for (const [key, fact] of previous) {
          if (fact) {
            capture.set(key, fact);
          } else {
            capture.delete(key);
          }
        }
      },
    });
  }
  const next = publication(captureReceipt(db, facts));
  if (!stageSqliteCommittedPublication(db, next) && !db.isTransaction) {
    publishSqliteCommittedState(next);
  }
}

function stagePluginStatePostimage(db: DatabaseSync, row: PluginStateRow): void {
  stage(db, new Map([[keyFor(row), { kind: "postimage", value: { ...row } }]]));
}

/** DELETE RETURNING captures exact tombstones, including eviction and whole-namespace clear. */
function stagePluginStateDeletions(db: DatabaseSync, rows: readonly EntryKey[]): void {
  stage(db, new Map(rows.map((row) => [keyFor(row), { kind: "absent" }])));
}

/** Capture the whole native transaction before COMMIT, including keys changed by retention. */
export function withPluginStateWorkerReceipt<T>(db: DatabaseSync, write: () => T): T {
  return state.capture.run(new Map(), () => {
    const result = write();
    const facts = state.capture.getStore()!;
    // Empty receipts distinguish a confirmed no-op from missing commit evidence.
    const receipt = captureReceipt(db, facts);
    // Publication cannot make a previously valid large clear/import fail to commit.
    // Unbounded retained namespaces may exceed the transport even with keys alone.
    deferSqliteWorkerCommitReceipt(
      db,
      serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
        ? receipt
        : { kind: "unknown", identity: receipt.source.identity },
      facts.size === 0 ? "settlement" : "commit",
    );
    return result;
  });
}

function isRow(value: unknown): value is PluginStateRow {
  return (
    isRecord(value) &&
    typeof value.plugin_id === "string" &&
    typeof value.namespace === "string" &&
    typeof value.entry_key === "string" &&
    typeof value.value_json === "string" &&
    (typeof value.created_at === "number" || typeof value.created_at === "bigint") &&
    (value.expires_at === null ||
      typeof value.expires_at === "number" ||
      typeof value.expires_at === "bigint")
  );
}

function readReceipt(value: unknown): Receipt {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    typeof value.source.identity !== "string" ||
    typeof value.source.incarnation !== "string" ||
    !(value.facts instanceof Map) ||
    !hasSqliteCommitReceiptCoverage(value, {
      source: { identity: value.source.identity, incarnation: value.source.incarnation },
      domain: "plugin-state",
      keys: [...value.facts.keys()],
    }) ||
    ![...value.facts].every(
      ([key, fact]) =>
        typeof key === "string" &&
        (fact.kind === "absent" ||
          (fact.kind === "postimage" && isRow(fact.value) && keyFor(fact.value) === key)),
    )
  ) {
    throw new Error("Plugin state commit receipt is invalid");
  }
  // SAFETY: The private transport envelope, exact keys and every row field were checked above.
  return value as Receipt;
}

/** A late worker reply cannot overwrite a newer native publication or reopen a closed owner. */
export function withPluginStatePublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    const identity = () => context.admission.identity.key;
    const superseded = new Set<string>();
    const operationId = randomUUID();
    let installing = false;
    let unknown = false;
    let received = false;
    let finished = false;
    const unsubscribe = pluginStatePublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if (change.kind === "committed" && change.receipt.source.identity === identity()) {
        for (const key of change.receipt.facts.keys()) {
          superseded.add(key);
        }
      } else if (change.kind === "unknown" && change.identity === identity()) {
        unknown = true;
      }
    });
    const finish = owner.admission.finish.bind(owner.admission);
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
          install({ kind: "settled", identity: identity(), operationId });
        }
      }
    };
    try {
      install({ kind: "pending", identity: identity(), operationId });
    } catch (error) {
      unsubscribe();
      owner.admission.finish();
      throw error;
    }
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      try {
        if (isRecord(facts) && facts.kind === "unknown" && facts.identity === identity()) {
          received = true;
          install({ kind: "unknown", identity: identity() });
          return;
        }
        const receipt = readReceipt(facts);
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
        if (receipt.source.identity !== identity()) {
          throw new Error("Plugin state receipt changed owner");
        }
        const current: Receipt = {
          ...receipt,
          facts: new Map(
            [...receipt.facts].map(([key, fact]) => [
              key,
              unknown || superseded.has(key) ? { kind: "unknown" } : fact,
            ]),
          ),
        };
        installing = true;
        publishSqliteCommittedState(publication(current));
        received = true;
      } catch (error) {
        install({ kind: "unknown", identity: identity() });
        throw error;
      } finally {
        installing = false;
      }
    });
    return owner;
  };
}

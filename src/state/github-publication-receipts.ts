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
} from "../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type PresentationColumn = "title" | "body" | "next_action";
type Rows = {
  shared: Omit<DB["github_publication_requests"], PresentationColumn>;
  personal: Omit<DB["github_personal_publication_requests"], PresentationColumn>;
  repository: Omit<DB["github_repository_publication_requests"], PresentationColumn>;
  "shared-lifecycle": DB["github_publication_session_lifecycles"];
  "personal-lifecycle": DB["github_publication_session_lifecycles"];
};
type Row = Rows[keyof Rows];

type Receipt = SqliteCommitReceipt<Row>;
export type GitHubPublicationAuthorityReceipt =
  | Receipt
  | { kind: "unknown"; identity: string | symbol };
type Change =
  | { kind: "committed"; receipt: Receipt }
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending" | "settled"; identity: string | symbol; operationId: string };

const state = resolveGlobalSingleton(Symbol.for("openclaw.githubPublicationReceipts"), () => ({
  sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
  capture: new AsyncLocalStorage<{
    db: DatabaseSync;
    facts: Map<string, SqliteCommittedFact<Row>>;
  }>(),
  facts: new Set<(change: Change) => void>(),
}));

function install(change: Change): void {
  const failures: unknown[] = [];
  notifyListeners(state.facts, change, (error) => failures.push(error));
  if (failures.length) {
    throw new AggregateError(failures, "GitHub publication fact installation failed");
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

/** Exact owner writes only: arbitrary raw SQL remains outside this coverage. */
export const githubPublicationReceipts = {
  stageRow: stageGitHubPublicationRow,
  subscribeFacts: (listener: (change: Change) => void) => registerListener(state.facts, listener),
};

function createGitHubPublicationReceipt(
  db: DatabaseSync,
  facts: ReadonlyMap<string, SqliteCommittedFact<Row>>,
): Receipt {
  let source = state.sources.get(db);
  if (!source) {
    source = {
      identity: readTrackedStateDatabaseIdentity(db)?.key ?? Symbol("untracked-github-publication"),
      incarnation: randomUUID(),
    };
    state.sources.set(db, source);
  }
  return createSqliteCommitReceipt({
    source,
    domain: "github-publication",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
}

export function deferGitHubPublicationDeletionReceipt(
  db: DatabaseSync,
  tombstones: ReadonlyMap<string, { kind: "absent" }>,
): void {
  const receipt = createGitHubPublicationReceipt(db, tombstones);
  // Historical cleanup is unbounded; receipt transport must not prevent its durable deletion.
  deferSqliteWorkerCommitReceipt(
    db,
    serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
      ? receipt
      : { kind: "unknown", identity: receipt.source.identity },
    tombstones.size ? "commit" : "settlement",
  );
}

/** Capture the same authority rows as native writes, including their lifecycle sidecars. */
export function captureGitHubPublicationWorkerReceipt<T extends object>(
  db: DatabaseSync,
  write: () => T,
): T & { authority: GitHubPublicationAuthorityReceipt } {
  const facts = new Map<string, SqliteCommittedFact<Row>>();
  return state.capture.run({ db, facts }, () => {
    const value = write();
    const authority = createGitHubPublicationReceipt(db, facts);
    const receipt: T & { authority: GitHubPublicationAuthorityReceipt } = { ...value, authority };
    if (serialize(receipt).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
      receipt.authority = { kind: "unknown", identity: authority.source.identity };
    }
    return receipt;
  });
}

function stageGitHubPublicationRow<Kind extends keyof Rows>(
  db: DatabaseSync,
  kind: Kind,
  row: Rows[Kind] & Partial<Record<PresentationColumn, string | null>>,
): void {
  const value = { ...row };
  delete value.title;
  delete value.body;
  delete value.next_action;
  const key = JSON.stringify([kind, row.request_id]);
  const fact = { kind: "postimage", value } as const;
  const capture = state.capture.getStore();
  if (capture?.db === db) {
    const previous = capture.facts.get(key);
    stageSqliteTransactionState(db, {
      stage: () => capture.facts.set(key, fact),
      commit() {},
      rollback: () => (previous ? capture.facts.set(key, previous) : capture.facts.delete(key)),
    });
  }
  const receipt = createGitHubPublicationReceipt(db, new Map([[key, fact]]));
  const next = publication(receipt);
  if (!stageSqliteCommittedPublication(db, next) && !db.isTransaction) {
    publishSqliteCommittedState(next);
  }
}

/** The deletion worker sends tombstones, including lifecycle rows, before its ordinary reply. */
export function withGitHubPublicationDeletionReceipt(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return withGitHubPublicationReceipt(createAdmission, context, false);
}

function withGitHubPublicationReceipt(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
  mutation: boolean,
  publish?: (facts: unknown) => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    const identity = () => context.admission.identity.key;
    const operationId = randomUUID();
    const superseded = new Set<string>();
    let received = false;
    let installing = false;
    let unknown = false;
    let finished = false;
    const unsubscribe = githubPublicationReceipts.subscribeFacts((change) => {
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
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts: payload }) => {
      try {
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
        const facts = mutation && isRecord(payload) ? payload.authority : payload;
        if (isRecord(facts) && facts.kind === "unknown" && facts.identity === identity()) {
          received = true;
          install({ kind: "unknown", identity: identity() });
          publish?.(payload);
          return;
        }
        if (
          !isRecord(facts) ||
          !isRecord(facts.source) ||
          facts.source.identity !== identity() ||
          typeof facts.source.incarnation !== "string" ||
          !(facts.facts instanceof Map) ||
          !hasSqliteCommitReceiptCoverage(facts, {
            source: { identity: identity(), incarnation: facts.source.incarnation },
            domain: "github-publication",
            keys: [...facts.facts.keys()],
          }) ||
          ![...facts.facts].every(([key, fact]) => {
            if (typeof key !== "string" || !isRecord(fact)) {
              return false;
            }
            const decoded: unknown = JSON.parse(key);
            if (
              !(
                Array.isArray(decoded) &&
                decoded.length === 2 &&
                (mutation
                  ? ["shared", "personal", "repository", "shared-lifecycle", "personal-lifecycle"]
                  : ["personal", "repository", "personal-lifecycle"]
                ).includes(decoded[0]) &&
                typeof decoded[1] === "string"
              )
            ) {
              return false;
            }
            return (
              fact.kind === "absent" ||
              (mutation &&
                fact.kind === "postimage" &&
                isRecord(fact.value) &&
                fact.value.request_id === decoded[1])
            );
          })
        ) {
          throw new Error("GitHub publication authority receipt is invalid");
        }
        // SAFETY: The private worker owns row shapes; the envelope and exact keys were checked above.
        const receipt = facts as Receipt;
        installing = true;
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
        received = true;
        publish?.(payload);
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

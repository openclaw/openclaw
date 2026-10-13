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

/** Request digests bind content; authority publication does not materialize presentation text. */
export const sharedGitHubPublicationAuthorityColumns = [
  "request_id",
  "idempotency_key",
  "request_digest",
  "session_id",
  "session_key",
  "agent_id",
  "worktree_id",
  "repository_fingerprint",
  "claim_id",
  "run_id",
  "environment_id",
  "owner_epoch",
  "placement_generation",
  "identity_source",
  "identity_profile_id",
  "identity_account_id",
  "identity_login",
  "status",
  "gateway_instance_id",
  "repository",
  "branch",
  "base_branch",
  "source_head_commit",
  "source_index_tree",
  "workspace_tree",
  "head_commit",
  "pull_request_url",
  "error_code",
  "created_at_ms",
  "updated_at_ms",
  "reported_at_ms",
] as const satisfies readonly (keyof Rows["shared"])[];

type Receipt = SqliteCommitReceipt<Row>;
type Change =
  | { kind: "committed"; receipt: Receipt }
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending" | "settled"; identity: string | symbol; operationId: string };

const state = resolveGlobalSingleton(Symbol.for("openclaw.githubPublicationReceipts"), () => ({
  sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
  installingFacts: 0,
  facts: new Set<(change: Change) => void>(),
}));

function install(change: Change): void {
  const failures: unknown[] = [];
  state.installingFacts++;
  try {
    notifyListeners(state.facts, change, (error) => failures.push(error));
  } finally {
    state.installingFacts--;
  }
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

function stageGitHubPublicationRow<Kind extends keyof Rows>(
  db: DatabaseSync,
  kind: Kind,
  row: Rows[Kind] & Partial<Record<PresentationColumn, string | null>>,
): void {
  if (state.installingFacts) {
    throw new Error("GitHub publication cannot mutate during fact installation");
  }
  const value = { ...row };
  delete value.title;
  delete value.body;
  delete value.next_action;
  const receipt = createGitHubPublicationReceipt(
    db,
    new Map([[JSON.stringify([kind, row.request_id]), { kind: "postimage", value }]]),
  );
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
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      try {
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
        if (isRecord(facts) && facts.kind === "unknown" && facts.identity === identity()) {
          received = true;
          install({ kind: "unknown", identity: identity() });
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
            if (typeof key !== "string" || !isRecord(fact) || fact.kind !== "absent") {
              return false;
            }
            const decoded: unknown = JSON.parse(key);
            return (
              Array.isArray(decoded) &&
              decoded.length === 2 &&
              ["personal", "repository", "personal-lifecycle"].includes(decoded[0]) &&
              typeof decoded[1] === "string"
            );
          })
        ) {
          throw new Error("GitHub publication deletion receipt is invalid");
        }
        // SAFETY: The envelope and every exact tombstone key are validated above.
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

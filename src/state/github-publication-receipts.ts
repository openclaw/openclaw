import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import type { SqliteCommitReceipt, SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { GitHubPublicationSessionLifecycle } from "./github-publication-read.types.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateReadContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  createKeyedStateDomainPublication,
  type StateDomainChange,
} from "./state-domain-publication.js";

type PresentationColumn = "title" | "body" | "next_action";
type Rows = {
  shared: Omit<DB["github_publication_requests"], PresentationColumn>;
  personal: Omit<DB["github_personal_publication_requests"], PresentationColumn>;
  repository: Omit<DB["github_repository_publication_requests"], PresentationColumn>;
  "shared-lifecycle": DB["github_publication_session_lifecycles"];
  "personal-lifecycle": DB["github_publication_session_lifecycles"];
};
type Row = Rows[keyof Rows];

export type GitHubPublicationAuthorityReceipt =
  | SqliteCommitReceipt<Row>
  | { kind: "unknown"; identity: string | symbol };

function isPublicationFact(key: string, fact: SqliteCommittedFact<unknown>, mutation: boolean) {
  const decoded: unknown = JSON.parse(key);
  return (
    Array.isArray(decoded) &&
    decoded.length === 2 &&
    (mutation
      ? ["shared", "personal", "repository", "shared-lifecycle", "personal-lifecycle"]
      : ["personal", "repository", "personal-lifecycle"]
    ).includes(decoded[0]) &&
    typeof decoded[1] === "string" &&
    (fact.kind === "absent" ||
      (mutation &&
        fact.kind === "postimage" &&
        isRecord(fact.value) &&
        fact.value.request_id === decoded[1]))
  );
}

const publication = createKeyedStateDomainPublication<Row>({
  domain: "github-publication",
  isFact: (key, fact) => isPublicationFact(key, fact, true),
  invalidReceiptMessage: "GitHub publication authority receipt is invalid",
  installFailureMessage: "GitHub publication fact installation failed",
});

/** Exact owner writes only: arbitrary raw SQL remains outside this coverage. */
export const githubPublicationReceipts = {
  stageRow: stageGitHubPublicationRow,
  subscribeFacts: (listener: (change: StateDomainChange<Row>, deletionPending: boolean) => void) =>
    publication.subscribeFacts((change) =>
      listener(
        change,
        change.kind === "pending" &&
          typeof change.identity === "string" &&
          owners.get(change.identity)?.pendingDeletion === true,
      ),
    ),
};

type LifecycleCell = { loaded: boolean; value?: GitHubPublicationSessionLifecycle };
type LifecycleOwner = {
  cells: Map<string, LifecycleCell>;
  pending: Set<string>;
  uncertain: boolean;
  pendingDeletion?: boolean;
};
const owners = resolveGlobalMap<string, LifecycleOwner>(
  Symbol.for("openclaw.githubPublicationLifecycleAuthority"),
  "close-and-restart",
);
function ownerFor(identity: string) {
  let owner = owners.get(identity);
  if (!owner) {
    owner = { cells: new Map(), pending: new Set(), uncertain: false };
    owners.set(identity, owner);
  }
  return owner;
}

githubPublicationReceipts.subscribeFacts((change) => {
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  if (typeof identity !== "string") {
    return;
  }
  const owner = ownerFor(identity);
  if (change.kind === "pending") {
    owner.pending.add(change.operationId);
  } else if (change.kind === "settled") {
    owner.pending.delete(change.operationId);
  } else if (change.kind === "unknown") {
    owner.uncertain = true;
    owner.cells.clear();
  } else if (change.kind === "committed") {
    for (const [key, fact] of change.receipt.facts) {
      if (fact.kind !== "postimage") {
        owner.cells.delete(key);
      } else if ("lifecycle_revision" in fact.value) {
        const existing = owner.cells.get(key);
        // Bindings are immutable. Reinsert never revives an already retained binding.
        const cell: LifecycleCell = existing && !existing.loaded ? existing : { loaded: false };
        cell.value = {
          lifecycle_revision: fact.value.lifecycle_revision,
          requester_authority_json: fact.value.requester_authority_json,
        };
        cell.loaded = true;
        owner.cells.set(key, cell);
      }
    }
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    if (event.identity) {
      owners.delete(event.identity.key);
    } else {
      owners.clear();
    }
  }
});

/** Capture before the cold read; this module observes pending even before the first reader. */
export function captureGitHubPublicationLifecycle(
  context: OpenClawStateReadContext,
  input: { publicationKind: "shared" | "personal"; requestId: string },
) {
  const identity = context.admission.identity.key;
  const owner = ownerFor(identity);
  const key = JSON.stringify([`${input.publicationKind}-lifecycle`, input.requestId]);
  let cell = owner.cells.get(key);
  if (!cell) {
    cell = { loaded: false };
    owner.cells.set(key, cell);
  }
  const retained = cell;
  const readCurrent = () => {
    context.admission.assertCurrent();
    if (
      owners.get(identity) !== owner ||
      owner.cells.get(key) !== retained ||
      owner.pending.size ||
      owner.uncertain
    ) {
      throw new Error(
        "GitHub publication lifecycle authority is unavailable; retry after owner recovery",
      );
    }
    return retained.value && { ...retained.value };
  };
  readCurrent();
  return {
    loaded: retained.loaded,
    readCurrent,
    observe(value: GitHubPublicationSessionLifecycle | undefined) {
      readCurrent();
      // A committed postimage takes precedence over a cold read dispatched before it.
      if (!retained.loaded) {
        retained.value = value;
        retained.loaded = true;
      }
    },
  };
}

export function deferGitHubPublicationDeletionReceipt(
  db: DatabaseSync,
  tombstones: ReadonlyMap<string, { kind: "absent" }>,
): void {
  const receipt = publication.receipt(sqlPublicationAnchor(db), tombstones);
  // Historical cleanup is unbounded; receipt transport must not prevent its durable deletion.
  deferSqliteWorkerCommitReceipt(
    sqlPublicationAnchor(db),
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
  const { result, receipt: authority } = publication.capture(sqlPublicationAnchor(db), write);
  const receipt: T & { authority: GitHubPublicationAuthorityReceipt } = { ...result, authority };
  if (serialize(receipt).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    receipt.authority = { kind: "unknown", identity: authority.source.identity };
  }
  return receipt;
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
  publication.stagePostimages(sqlPublicationAnchor(db), [
    [JSON.stringify([kind, row.request_id]), value],
  ]);
}

/** The deletion worker sends tombstones, including lifecycle rows, before its ordinary reply. */
export function withGitHubPublicationDeletionReceipt(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return withGitHubPublicationReceipt(createAdmission, context, false);
}

/** Register before presentation observers so every reply sees installed authority facts. */
export function withGitHubPublicationWorkerReceipt(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
  publish: (facts: unknown) => void,
): SqliteWorkerAdmissionFactory {
  return withGitHubPublicationReceipt(createAdmission, context, true, publish);
}

function withGitHubPublicationReceipt(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
  mutation: boolean,
  publish?: (facts: unknown) => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    let pending: ReturnType<typeof publication.begin>;
    const lifecycleOwner = ownerFor(context.admission.identity.key);
    const previousDeletion = lifecycleOwner.pendingDeletion;
    try {
      // Pending listeners run synchronously; source preparation only loses authority on deletion.
      lifecycleOwner.pendingDeletion = !mutation;
      pending = publication.begin(
        {
          identity: context.admission.identity.key,
          assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
        },
        // Deletion owns personal/repository tombstones, never shared or replacement rows.
        mutation ? undefined : (key, fact) => isPublicationFact(key, fact, false),
      );
    } catch (error) {
      owner.admission.finish();
      throw error;
    } finally {
      lifecycleOwner.pendingDeletion = previousDeletion;
    }
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        if (owner.admission.settlement) {
          const confirmed = owner.admission.settlement.kind === "completed";
          pending.finish(confirmed, confirmed && !owner.admission.committed);
        }
      }
    };
    void operation.settled.then((outcome) => {
      const known = outcome.kind !== "unknown";
      pending.finish(known, known && !owner.admission.committed);
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts: payload }) => {
      pending.committed(mutation && isRecord(payload) ? payload.authority : payload, () =>
        publish?.(payload),
      );
    });
    return owner;
  };
}

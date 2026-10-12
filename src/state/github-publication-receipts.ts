import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteCommitReceipt, SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createKeyedStateDomainPublication } from "./state-domain-publication.js";

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
  subscribeFacts: publication.subscribeFacts,
};

export function deferGitHubPublicationDeletionReceipt(
  db: DatabaseSync,
  tombstones: ReadonlyMap<string, { kind: "absent" }>,
): void {
  const receipt = publication.receipt(db, tombstones);
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
  const { result, receipt: authority } = publication.capture(db, write);
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
  publication.stagePostimages(db, [[JSON.stringify([kind, row.request_id]), value]]);
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
    try {
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
    }
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        pending.finish(owner.admission.settlement?.kind === "completed");
      }
    };
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts: payload }) => {
      pending.committed(mutation && isRecord(payload) ? payload.authority : payload, () =>
        publish?.(payload),
      );
    });
    return owner;
  };
}

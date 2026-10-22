import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { SqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../../infra/sqlite-worker-operation-settlement.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { createKeyedStateDomainPublication } from "../../state/state-domain-publication.js";

type RegistryRow = Selectable<DB["worktrees"]>;
type LeaseRow = Selectable<DB["state_leases"]>;
type RegistryFact = RegistryRow | LeaseRow;
type Receipt = SqliteCommitReceipt<RegistryFact>;
type WorkerReceipt<T = unknown> = {
  publication: Receipt | { kind: "unknown"; identity: string | symbol };
  result: { kind: "known"; value: T } | { kind: "unknown" };
  receipt?: string;
};

function keyFor(row: Pick<RegistryRow, "id"> | Pick<LeaseRow, "scope" | "lease_key">): string {
  return "id" in row
    ? JSON.stringify(["worktrees", row.id])
    : JSON.stringify(["state_leases", row.scope, row.lease_key]);
}

const publication = createKeyedStateDomainPublication<RegistryFact>({
  domain: "worktree-registry",
  isFact: (key, fact) => {
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
  },
  invalidReceiptMessage: "Worktree registry receipt is invalid",
  installFailureMessage: "Worktree registry fact installation failed",
  mutationDuringInstallMessage: "Worktree registry cannot mutate during fact installation",
  changedOwnerMessage: "Worktree registry receipt changed owner",
});

/** Exact owner-written rows only; raw writes and protecting session/placement sets remain separate. */
export const worktreeRegistryPublication = {
  subscribeFacts: publication.subscribeFacts,
  rows(db: EngineConnection, rows: readonly RegistryFact[]) {
    publication.stageFacts(
      db,
      new Map(rows.map((row) => [keyFor(row), { kind: "postimage", value: { ...row } }])),
    );
  },
  deleted(
    db: EngineConnection,
    rows: readonly (RegistryRow | Pick<LeaseRow, "scope" | "lease_key">)[],
  ) {
    publication.stageDeletions(db, rows.map(keyFor));
  },
};

/** The result and existing operation token survive ordinary reply loss without replaying the write. */
export function withWorktreeRegistryWorkerReceipt<T>(
  db: EngineConnection,
  write: () => T,
  receipt?: string,
): T {
  const { result, receipt: committed } = publication.capture(db, write);
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
  deferSqliteWorkerCommitReceipt(db, payload, committed.facts.size ? "commit" : "settlement");
  return result;
}

function readWorkerReceiptEnvelope(value: unknown) {
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
  const result: WorkerReceipt["result"] =
    value.result.kind === "known"
      ? { kind: "known", value: value.result.value }
      : { kind: "unknown" };
  return { publication: value.publication, result, receipt: value.receipt };
}

export function readWorktreeRegistryWorkerReceipt(value: unknown): WorkerReceipt | undefined {
  const envelope = readWorkerReceiptEnvelope(value);
  if (!envelope) {
    return undefined;
  }
  const receipt = envelope.publication;
  if (receipt.kind === "unknown" && typeof receipt.identity === "string") {
    return { ...envelope, publication: { kind: "unknown", identity: receipt.identity } };
  }
  try {
    return { ...envelope, publication: publication.readReceipt(receipt) };
  } catch {
    // Recovery can use the ordinary result when no complete native receipt was retained.
    return undefined;
  }
}

export function withWorktreeRegistryPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    let pending: ReturnType<typeof publication.begin>;
    try {
      pending = publication.begin({
        identity: context.admission.identity.key,
        assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
      });
    } catch (error) {
      owner.admission.finish();
      throw error;
    }
    observeSqliteWorkerAdmissionFinish(owner.admission, () => {
      pending.finish(owner.admission.settlement?.kind === "completed");
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      const committed = readWorkerReceiptEnvelope(facts);
      if (!committed) {
        throw new Error("Worktree registry receipt is invalid");
      }
      pending.committed(committed.publication);
    });
    return owner;
  };
}

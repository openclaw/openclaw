import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "../state/state-domain-publication.js";

type WorkspaceStateFact =
  | { kind: "setup"; row: Selectable<DB["workspace_setup_state"]> }
  | { kind: "alias"; row: Selectable<DB["workspace_path_aliases"]> }
  | { kind: "hashes"; workspaceKey: string; hashes: readonly (readonly [string, string])[] };

export function workspaceStateFactKey(kind: WorkspaceStateFact["kind"], key: string): string {
  return JSON.stringify([kind, key]);
}

export const workspaceStatePublication = createStateDomainPublication<WorkspaceStateFact>({
  domain: "workspace-state",
  keyOf: (value) =>
    workspaceStateFactKey(
      value.kind,
      value.kind === "hashes"
        ? value.workspaceKey
        : value.kind === "alias"
          ? value.row.alias_key
          : value.row.workspace_key,
    ),
  isValue: (value): value is WorkspaceStateFact => {
    if (!isRecord(value)) {
      return false;
    }
    if (value.kind === "hashes") {
      return (
        typeof value.workspaceKey === "string" &&
        Array.isArray(value.hashes) &&
        value.hashes.every(
          (entry) =>
            Array.isArray(entry) && entry.length === 2 && entry.every((v) => typeof v === "string"),
        )
      );
    }
    const row = value.row;
    if (!isRecord(row)) {
      return false;
    }
    return value.kind === "alias"
      ? ["alias_key", "alias_path", "workspace_key", "workspace_path"].every(
          (key) => typeof row[key] === "string",
        ) && typeof row.updated_at_ms === "number"
      : value.kind === "setup" &&
          typeof row.workspace_key === "string" &&
          ["workspace_path", "bootstrap_seeded_at", "setup_completed_at"].every(
            (key) => row[key] === null || typeof row[key] === "string",
          ) &&
          ["version", "updated_at", "attested_at_ms", "attestation_updated_at_ms"].every(
            (key) => row[key] === null || typeof row[key] === "number",
          );
  },
});

export function captureWorkspaceStateReceipt<T>(db: DatabaseSync, run: () => T): T {
  const { result, receipt } = workspaceStatePublication.capture(db, run);
  deferSqliteWorkerCommitReceipt(
    db,
    {
      kind: "workspace-state",
      result,
      receipt: workspaceStatePublication.bound(receipt),
    },
    receipt.facts.size === 0 ? "settlement" : "commit",
  );
  return result;
}

export function workspaceStateReceiptResult(facts: unknown): unknown {
  if (!isRecord(facts) || facts.kind !== "workspace-state") {
    throw new Error("Workspace state has no committed receipt");
  }
  return facts.result;
}

export function withWorkspaceStatePublication(
  context: OpenClawStateWorkerContext,
  createAdmission: SqliteWorkerAdmissionFactory,
  onCommitted?: (facts: unknown) => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const accepted = createAdmission(operation);
    const publication = workspaceStatePublication.begin({
      get identity() {
        return context.admission.identity.key;
      },
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(accepted.admission, ({ facts }) => {
      workspaceStateReceiptResult(facts);
      if (isRecord(facts)) {
        publication.committed(facts.receipt);
      }
      onCommitted?.(facts);
    });
    void operation.settled.then((settlement) =>
      publication.finish(settlement.kind === "completed"),
    );
    return accepted;
  };
}

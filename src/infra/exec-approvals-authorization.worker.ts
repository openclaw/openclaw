import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { applyExecAuthorizationCommit } from "./exec-approvals-authorization.kernel.js";
import { resolveExecApprovalsDisplayPath } from "./exec-approvals-config.js";
import type {
  ExecAuthorizationCommitInput,
  ExecAuthorizationCommitOutcome,
} from "./exec-approvals-contracts.js";
import type { ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import { assertExecApprovalsHostPolicyUnchanged } from "./exec-approvals-policy.js";
import {
  snapshotFromExecApprovalsDatabase,
  assertExecApprovalsMutationAllowed,
  ExecApprovalsMutationFencedError,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";

function applyAuthorizationBatch(
  db: DatabaseSync,
  initial: ExecApprovalsSnapshot,
  items: readonly ExecAuthorizationCommitInput[],
) {
  let current = initial;
  const outcomes = items.map((item): ExecAuthorizationCommitOutcome => {
    let next: ReturnType<typeof applyExecAuthorizationCommit>;
    try {
      next = applyExecAuthorizationCommit(structuredClone(current.file), item);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (next !== null) {
      assertExecApprovalsHostPolicyUnchanged(current.file, next);
      try {
        assertExecApprovalsMutationAllowed({ db, current: current.file, next });
      } catch (error) {
        if (!(error instanceof ExecApprovalsMutationFencedError)) {
          throw error;
        }
        return { ok: false, message: error.message };
      }
      const raw = serializeExecApprovals(next);
      if (!current.exists || current.raw !== raw) {
        current = snapshotFromExecApprovalsRow({ path: current.path, row: { raw_json: raw } });
      }
    }
    return { ok: true, snapshot: current };
  });
  return { snapshot: current, outcomes };
}

export function commitExecAuthorizationsInWorker(
  input: { items: ExecAuthorizationCommitInput[] },
  options: OpenClawStateDatabaseOptions,
): ExecAuthorizationCommitOutcome[] {
  assertNoPendingLegacyExecApprovals({ env: options.env });
  const database = openOpenClawStateDatabase(options);
  const read = () =>
    snapshotFromExecApprovalsDatabase(database.db, resolveExecApprovalsDisplayPath(options.env));
  const initial = read();
  const prepared = applyAuthorizationBatch(database.db, initial, input.items);
  if (prepared.snapshot.raw === initial.raw) {
    return prepared.outcomes;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Policy may change while admission waits; only this authoritative pass commits.
      const current = read();
      const committed = applyAuthorizationBatch(db, current, input.items);
      if (committed.snapshot.raw !== current.raw) {
        writeExecApprovalsConfigRow({
          db,
          file: committed.snapshot.file,
          raw: committed.snapshot.raw ?? undefined,
        });
      }
      return committed.outcomes;
    },
    { ...options, database },
    { operationLabel: "exec-approvals.commit-authorizations" },
  );
}

export const execAuthorizationOperations = {
  "execApprovals.commitAuthorizations": (
    input: { items: ExecAuthorizationCommitInput[] },
    { open, stateOptions },
  ) => commitExecAuthorizationsInWorker(input, { ...stateOptions(), database: open() }),
} satisfies WorkerOperationHandlers;

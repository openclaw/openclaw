import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import {
  generateToken,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import {
  applyExecApprovalsUpdate,
  type ExecApprovalsUpdate,
} from "./exec-approvals-mutation.kernel.js";
import {
  assertExecApprovalsMutationAllowed,
  deleteExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsDatabase,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

function mutate<T>(
  context: WorkerWriteOperationContext,
  label: string,
  operation: (
    current: ExecApprovalsSnapshot,
    db: ReturnType<WorkerWriteOperationContext["open"]>["db"],
  ) => {
    next: ExecApprovalsFile | null;
    result: (snapshot: ExecApprovalsSnapshot) => T;
    raw?: string;
    remove?: boolean;
  },
): T {
  const options = context.stateOptions();
  assertNoPendingLegacyExecApprovals({ env: options.env });
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const current = snapshotFromExecApprovalsDatabase(
        db,
        resolveExecApprovalsDisplayPath(options.env),
      );
      const edit = operation(current, db);
      let snapshot = current;
      if (edit.next !== null) {
        const raw = edit.raw ?? serializeExecApprovals(edit.next);
        if (edit.remove || !current.exists || current.raw !== raw) {
          if (edit.remove) {
            deleteExecApprovalsConfigRow(db);
            snapshot = snapshotFromExecApprovalsRow({ path: current.path });
          } else {
            const persisted = writeExecApprovalsConfigRow({ db, file: edit.next, raw: edit.raw });
            snapshot = snapshotFromExecApprovalsRow({
              path: current.path,
              row: { raw_json: persisted },
            });
          }
        }
      }
      const changed = snapshot.raw !== current.raw;
      const facts = changed ? { kind: "exec-policy-publication", file: snapshot.file } : undefined;
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
      if (changed) {
        deferSqliteWorkerCommitReceipt(db, facts);
      }
      return edit.result(snapshot);
    },
    { operationLabel: label },
  );
}

export const execPolicyMutationOperations = {
  "execApprovals.update": (
    input: { baseHash?: string; update: ExecApprovalsUpdate },
    context: WorkerWriteOperationContext,
  ) =>
    mutate(context, "exec-approvals.update", (current, db) => {
      if (input.baseHash !== undefined && current.hash !== input.baseHash) {
        return { next: null, result: () => null };
      }
      const next = applyExecApprovalsUpdate(current.file, input.update);
      if (next) {
        assertExecApprovalsMutationAllowed({ db, current: current.file, next });
      }
      return { next, result: (snapshot) => snapshot };
    }),
  "execApprovals.restoreSnapshot": (
    input: { snapshot: ExecApprovalsSnapshot; baseHash: string },
    context: WorkerWriteOperationContext,
  ) =>
    mutate(context, "exec-approvals.restore-cas", (current, db) => {
      if (current.hash !== input.baseHash) {
        return { next: null, result: () => false };
      }
      assertExecApprovalsMutationAllowed({ db, current: current.file, next: input.snapshot.file });
      return {
        next: input.snapshot.file,
        raw: input.snapshot.raw ?? serializeExecApprovals(input.snapshot.file),
        remove: !input.snapshot.exists,
        result: () => true,
      };
    }),
  "execApprovals.ensureSnapshot": (_input: undefined, context: WorkerWriteOperationContext) => {
    const options = context.stateOptions();
    assertNoPendingLegacyExecApprovals({ env: options.env });
    const snapshot = snapshotFromExecApprovalsDatabase(
      context.open().db,
      resolveExecApprovalsDisplayPath(options.env),
    );
    const socketPath = resolveExecApprovalsSocketPath(options.env);
    const ensureSocket = (file: ExecApprovalsFile): ExecApprovalsFile => {
      const next = normalizeExecApprovalsInternal(file);
      return {
        ...next,
        socket: {
          path: next.socket?.path?.trim() || socketPath,
          token: next.socket?.token?.trim() || generateToken(),
        },
      };
    };
    if (
      snapshot.file.socket?.path?.trim() &&
      snapshot.file.socket.token?.trim() &&
      snapshot.raw === serializeExecApprovals(ensureSocket(snapshot.file))
    ) {
      return snapshot;
    }
    return mutate(context, "exec-approvals.ensure", (current, db) => {
      const next = ensureSocket(current.file);
      assertExecApprovalsMutationAllowed({ db, current: current.file, next });
      return { next, result: (result) => result };
    });
  },
};

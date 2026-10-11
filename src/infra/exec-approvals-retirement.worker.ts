import { isDeepStrictEqual } from "node:util";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import { assertAgentDeletionWorkerPredicate } from "../state/agent-deletion.worker.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import { resolveExecApprovalsDisplayPath } from "./exec-approvals-config.js";
import type { ExecApprovalsAgent } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import {
  ExecApprovalsMutationFencedError,
  serializeExecApprovals,
  snapshotFromExecApprovalsDatabase,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { deferSqliteWorkerCommitReceipt } from "./sqlite-worker-operation-admission.js";

export type RemovedExecApprovalPolicies = Array<[string, ExecApprovalsAgent]>;

type RetirementInput = {
  guard: AgentDeletionWorkerGuard;
  nonce: string;
} & ({ action: "remove" } | { action: "restore"; entries: RemovedExecApprovalPolicies });

function retireAgentPolicies(
  input: RetirementInput,
  context: WorkerWriteOperationContext,
): RemovedExecApprovalPolicies {
  assertNoPendingLegacyExecApprovals({ env: context.stateOptions().env });
  const { guard } = input;
  const agentId = guard.predicate.agentId;
  if (guard.lease.scope !== "core:agent-deletion" || guard.lease.key !== agentId) {
    throw new ExecApprovalsMutationFencedError();
  }
  return context.write(
    (database) => {
      assertOpenClawStateLeaseWorkerOwnedInTransaction(database.db, guard.lease);
      assertAgentDeletionWorkerPredicate(database, guard.predicate);
      const current = snapshotFromExecApprovalsDatabase(
        database.db,
        resolveExecApprovalsDisplayPath(context.stateOptions().env),
      );
      const matches = (key: string) => {
        const normalized = normalizeAgentIdStrict(key);
        return normalized.ok && normalized.value === agentId;
      };
      const entries =
        input.action === "remove"
          ? Object.entries(current.file.agents ?? {}).filter(([key]) => matches(key))
          : input.entries;
      const agents = { ...current.file.agents };
      for (const [key, policy] of entries) {
        // The journal authorizes only this agent's aliases. Restoration cannot overwrite a new policy.
        if (
          !matches(key) ||
          (input.action === "restore" &&
            agents[key] !== undefined &&
            !isDeepStrictEqual(agents[key], policy))
        ) {
          throw new ExecApprovalsMutationFencedError();
        }
        if (input.action === "remove") {
          delete agents[key];
        } else {
          agents[key] = policy;
        }
      }
      const next = { ...current.file, agents };
      const raw = serializeExecApprovals(next);
      const changed = entries.length > 0 && raw !== current.raw;
      if (changed) {
        writeExecApprovalsConfigRow({ db: database.db, file: next, raw });
      }
      assertOpenClawStateLeaseWorkerOwnedInTransaction(
        database.db,
        guard.lease,
        "write",
        "commit",
        {
          kind: "exec-approvals-retirement",
          nonce: input.nonce,
          agentId,
          operationId: guard.predicate.operationId,
          action: input.action,
          raw: changed ? raw : null,
        },
      );
      deferSqliteWorkerCommitReceipt(database.db, {
        kind: "exec-approvals-retirement",
        nonce: input.nonce,
        action: input.action,
      });
      return entries;
    },
    { operationLabel: `exec-approvals.retirement-${input.action}` },
  );
}

export const execApprovalRetirementOperations = {
  "execApprovals.retireAgent": retireAgentPolicies,
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

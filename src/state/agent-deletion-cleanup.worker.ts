import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withAgentDeletionWorkerDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import { assertAgentDeletionWorkerPredicate } from "./agent-deletion.worker.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { verifyOpenClawStateLeaseOwnership } from "./openclaw-state-lease-storage.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";

const log = createSubsystemLogger("state/agent-deletion");

/** Keep lease grants separate from the agent command's commit and publication grants. */
function withLeaseAdmission<T>(
  guard: AgentDeletionWorkerGuard,
  run: (inLeaseAdmission: <Value>(operation: () => Value) => Value) => T,
): T {
  const { port1, port2 } = new MessageChannel();
  let admission: MessagePort | undefined;
  try {
    requestSqliteWorkerOperationAdmission(
      { stage: "prepare", facts: { kind: "agent-deletion-lease", guard, port: port2 } },
      [port2],
    );
    const received: unknown = receiveMessageOnPort(port1)?.message;
    if (!(received instanceof MessagePort)) {
      throw new Error("Agent deletion lost its live lease admission");
    }
    admission = received;
    return run((operation) => withSqliteWorkerOperationAdmission({ port: received }, operation));
  } finally {
    admission?.close();
    port1.close();
    port2.close();
  }
}

/** The executing agent worker holds agent -> shared locks through the actual agent COMMIT. */
export function withAgentDeletionWorkerCleanup<T>(
  guard: AgentDeletionWorkerGuard,
  target: {
    agentId: string;
    path: string;
    statePath: string;
    env: NodeJS.ProcessEnv;
    shared: () => OpenClawStateDatabase;
    assertFileCurrent: () => void;
  },
  run: () => T,
): T {
  if (guard.lease.scope !== "core:agent-deletion" || guard.lease.key !== guard.predicate.agentId) {
    throw new Error("Agent deletion requires its original target lease");
  }
  const assertSourceCurrent = () => {
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: { kind: "agent-deletion-current", guard },
    });
    target.assertFileCurrent();
  };
  const assertLease = (database: OpenClawStateDatabase) => {
    verifyOpenClawStateLeaseOwnership({
      ...guard.lease,
      leaseLabel: "agent deletion",
      transaction: database.db,
    });
  };
  const assertCurrent = () => {
    assertSourceCurrent();
    const database = target.shared();
    assertAgentDeletionWorkerPredicate(database, guard.predicate);
    assertLease(database);
  };
  return withAgentDeletionWorkerDatabaseCleanup(
    {
      ...target,
      ownsDatabase: target.agentId === guard.predicate.agentId,
      assertCurrent,
      assertJournal: (statePath, entries) => {
        if (statePath !== target.statePath) {
          throw new Error(
            `Agent ${guard.predicate.agentId} deletion no longer owns database cleanup.`,
          );
        }
        assertSourceCurrent();
        const database = target.shared();
        assertAgentDeletionWorkerPredicate(
          database,
          guard.predicate,
          entries.find((entry) => entry.agentId === guard.predicate.agentId) ?? null,
        );
        assertLease(database);
        return guard.predicate.agentId;
      },
      withCommit: (commit) => {
        let committed = false;
        try {
          withLeaseAdmission(guard, (inLeaseAdmission) =>
            runOpenClawStateWriteTransaction(
              (database) => {
                inLeaseAdmission(() =>
                  assertOpenClawStateLeaseWorkerOwnedInTransaction(database.db, guard.lease),
                );
                assertAgentDeletionWorkerPredicate(database, guard.predicate);
                inLeaseAdmission(() =>
                  assertOpenClawStateLeaseWorkerOwnedInTransaction(
                    database.db,
                    guard.lease,
                    "write",
                    "commit",
                  ),
                );
                // The lease grant yields to the host; keep source and physical authority live
                // until the original agent transaction actually commits.
                assertSourceCurrent();
                assertLease(database);
                commit();
                committed = true;
              },
              { database: target.shared(), path: target.statePath, env: target.env },
              { operationLabel: "agent.deletion.agent-commit" },
            ),
          );
        } catch (error) {
          if (!committed) {
            throw error;
          }
          try {
            log.warn("Agent deletion committed, but releasing its state guard failed", {
              agentId: guard.predicate.agentId,
              error,
            });
          } catch {
            // A diagnostic cannot roll back durable agent rows or companion bindings.
          }
        }
      },
    },
    run,
  );
}

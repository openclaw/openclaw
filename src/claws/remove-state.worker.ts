import { isDeepStrictEqual } from "node:util";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournalInDatabase,
  removeAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { clawPackageLifecycleLeaseKey } from "../state/claw-package-lifecycle-lease.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import { readOpenClawStateLeaseExpiry } from "../state/openclaw-state-lease-store.js";
import { releaseClawRemoveRows } from "./lifecycle-delete-support.js";
import { digestClawRemovalInstall } from "./package-remove-plan.js";
import {
  readClawInstallRecordFromDatabase,
  readClawPackageRefsInDatabase,
  updateClawPackageRefStatus,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { readClawRemoveFactsInDatabase } from "./remove-facts.kernel.js";
import {
  type ClawRemoveStateCommand,
  type ClawRemoveStateGuard,
  type ClawRemoveStateWorkerOperations,
} from "./remove-state-worker-contract.js";

function assertLease(
  input: Pick<ClawRemoveStateGuard, "agentId" | "lease">,
  database: OpenClawStateDatabase,
) {
  if (
    input.lease.scope !== "core:agent-deletion" ||
    input.lease.key !== input.agentId ||
    input.lease.leaseLabel !== "agent deletion"
  ) {
    throw new Error("Claw removal requires its exact agent deletion lease.");
  }
  verifyOpenClawStateLeaseOwnership({ ...input.lease, transaction: database.db });
}

function assertInstall(
  input: Pick<ClawRemoveStateGuard, "agentId" | "expectedInstall">,
  database: OpenClawStateDatabase,
) {
  if (
    !isDeepStrictEqual(
      readClawInstallRecordFromDatabase(database.db, input.agentId) ?? null,
      input.expectedInstall,
    )
  ) {
    throw new Error(`Claw removal no longer owns agent ${input.agentId}.`);
  }
}

function assertGuard(input: ClawRemoveStateGuard, database: OpenClawStateDatabase) {
  assertLease(input, database);
  const journal = readAgentDeletionJournalInDatabase(database, input.agentId);
  if (journal?.operationId !== input.operationId || journal.cleanupCompleted) {
    throw new Error(`Agent ${input.agentId} deletion no longer owns cleanup.`);
  }
  assertInstall(input, database);
}

function assertMonitorJournal(
  input: { agentId: string; operationId: string },
  database: OpenClawStateDatabase,
) {
  const journal = readAgentDeletionJournalInDatabase(database, input.agentId);
  if (journal?.operationId !== input.operationId || journal.cleanupCompleted) {
    throw new Error(`Agent ${input.agentId} deletion no longer owns monitor cleanup.`);
  }
}

function assertPackageRemovalOwner(
  input: {
    agentId: string;
    operationId: string;
    expectedInstallDigest: string;
  },
  database: OpenClawStateDatabase,
) {
  assertMonitorJournal(input, database);
  if (
    digestClawRemovalInstall(readClawInstallRecordFromDatabase(database.db, input.agentId)) !==
    input.expectedInstallDigest
  ) {
    throw new Error("Claw package cleanup install ownership changed.");
  }
}

function assertPackageLease(
  input: ClawRemoveStateWorkerOperations["claws.remove.packageRefStatus"]["input"],
  database: OpenClawStateDatabase,
) {
  const ref = input.expectedRef;
  const workspace =
    ref.kind === "skill"
      ? readClawInstallRecordFromDatabase(database.db, ref.agentId)?.workspace
      : undefined;
  if (ref.kind === "skill" && !workspace) {
    throw new Error("Claw package cleanup skill workspace is unavailable.");
  }
  const key = clawPackageLifecycleLeaseKey(
    ref.kind === "skill"
      ? { kind: "skill", source: ref.source, ref: ref.ref, workspace: workspace! }
      : { kind: "plugin", source: ref.source, ref: ref.ref },
  );
  if (
    input.packageLease.scope !== "claw-package-lifecycle" ||
    input.packageLease.key !== key ||
    readOpenClawStateLeaseExpiry(database.db, input.packageLease) === undefined
  ) {
    throw new Error("Claw package cleanup no longer owns its package lifecycle lease.");
  }
}

function matchingArtifactRefs(expected: PersistedClawPackageRef, database: OpenClawStateDatabase) {
  const workspace =
    expected.kind === "skill"
      ? readClawInstallRecordFromDatabase(database.db, expected.agentId)?.workspace
      : undefined;
  return readClawPackageRefsInDatabase(database.db, {
    kind: expected.kind,
    source: expected.source,
    ref: expected.ref,
  })
    .filter(
      (candidate) =>
        expected.kind !== "skill" ||
        candidate.agentId === expected.agentId ||
        (workspace !== undefined &&
          readClawInstallRecordFromDatabase(database.db, candidate.agentId)?.workspace ===
            workspace),
    )
    .toSorted((left, right) =>
      `${left.agentId}:${left.version}:${left.integrity}`.localeCompare(
        `${right.agentId}:${right.version}:${right.integrity}`,
      ),
    );
}

/** Finite journal and provenance transitions under the live deletion lease. */
export function executeClawRemoveStateCommand(
  command: ClawRemoveStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = (() => {
        switch (command.type) {
          case "claws.remove.claim": {
            const input = command.input;
            assertLease(input, database);
            assertInstall(input, database);
            const previous = readAgentDeletionJournalInDatabase(database, input.agentId);
            const journal = beginAgentDeletionJournal(
              {
                agentId: input.agentId,
                operationId: input.operationId,
                workspaceDir: input.workspaceDir,
                agentDir: input.agentDir,
                sessionsDir: input.sessionsDir,
                deleteFiles: previous?.deleteFiles ?? false,
              },
              { database },
            );
            assertGuard(input, database);
            return { existingJournal: Boolean(previous), journal };
          }
          case "claws.remove.assert":
            assertGuard(command.input, database);
            return;
          case "claws.remove.rollback": {
            assertGuard(command.input, database);
            if (
              !removeAgentDeletionJournal(command.input.agentId, command.input.operationId, {
                database,
              })
            ) {
              throw new Error(
                `Failed to roll back deletion journal for agent ${command.input.agentId}.`,
              );
            }
            return;
          }
          case "claws.remove.releaseRows": {
            assertGuard(command.input, database);
            const cleanupErrors = [...command.input.cleanupErrors];
            const complete = releaseClawRemoveRows(
              command.input.agentId,
              command.input.files,
              cleanupErrors,
              (current) => assertGuard(command.input, current),
              (current) => {
                if (
                  !completeAgentDeletionJournalInDatabase(
                    current,
                    command.input.agentId,
                    command.input.operationId,
                  )
                ) {
                  throw new Error(
                    `Failed to complete deletion journal for agent ${command.input.agentId}.`,
                  );
                }
              },
              { database },
            );
            return { complete, cleanupErrors };
          }
          case "claws.remove.packageRefStatus": {
            const input = command.input;
            assertPackageRemovalOwner(input, database);
            assertPackageLease(input, database);
            const actualRefs = matchingArtifactRefs(input.expectedRef, database);
            const expectedRefs = input.expectedArtifactRefs.toSorted((left, right) =>
              `${left.agentId}:${left.version}:${left.integrity}`.localeCompare(
                `${right.agentId}:${right.version}:${right.integrity}`,
              ),
            );
            if (!isDeepStrictEqual(actualRefs, expectedRefs)) {
              throw new Error("Claw package ownership changed before cleanup claim.");
            }
            const currentRef = actualRefs.find(
              (ref) =>
                ref.agentId === input.expectedRef.agentId &&
                ref.version === input.expectedRef.version &&
                ref.integrity === input.expectedRef.integrity,
            );
            if (!currentRef || !isDeepStrictEqual(currentRef, input.expectedRef)) {
              throw new Error("Claw package reference changed before cleanup claim.");
            }
            return updateClawPackageRefStatus(input.expectedRef, input.status, { database });
          }
          case "claws.monitors.assertNoAgentLeases":
            assertMonitorJournal(command.input, database);
            assertNoOpenClawAgentDatabaseLeases(command.input.agentId, { database });
            assertMonitorJournal(command.input, database);
            return;
          case "claws.monitors.quiesce": {
            assertMonitorJournal(command.input, database);
            assertInstall(command.input, database);
            const facts = readClawRemoveFactsInDatabase(database.db, command.input.agentId, []);
            if (
              !isDeepStrictEqual(facts.attachedJobs, command.input.expectedAttachedJobs) ||
              !isDeepStrictEqual(facts.cronRefs, command.input.expectedCronRefs)
            ) {
              throw new Error("Attached scheduled work changed before monitor cancellation.");
            }
            return;
          }
          case "claws.monitors.prepareDatabaseClose":
            assertMonitorJournal(command.input, database);
            assertInstall(command.input, database);
            return;
        }
      })();
      requestSqliteWorkerOperationAdmission({
        stage: "commit",
        facts:
          command.type === "claws.monitors.quiesce"
            ? {
                kind: "claw-monitor-quiesce",
                agentId: command.input.agentId,
                operationId: command.input.operationId,
              }
            : command.type === "claws.monitors.prepareDatabaseClose"
              ? {
                  kind: "claw-monitor-database-close",
                  agentId: command.input.agentId,
                  operationId: command.input.operationId,
                  databasePath: command.input.databasePath,
                }
              : undefined,
      });
      if (
        command.type === "claws.monitors.assertNoAgentLeases" ||
        command.type === "claws.monitors.quiesce" ||
        command.type === "claws.monitors.prepareDatabaseClose"
      ) {
        assertMonitorJournal(command.input, database);
        if (command.type !== "claws.monitors.assertNoAgentLeases") {
          assertInstall(command.input, database);
        }
      } else if (command.type === "claws.remove.packageRefStatus") {
        assertPackageRemovalOwner(command.input, database);
        assertPackageLease(command.input, database);
      } else {
        assertLease(command.input, database);
      }
      return result;
    },
    { database },
  );
}

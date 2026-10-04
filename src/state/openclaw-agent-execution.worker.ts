import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_OPERATION_CLEANUP,
  SQLITE_WORKER_PREPARE_ADMITTED,
  type SqliteWorkerCommand,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  normalizeDatabasePath,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
  SqliteWorkerOpenRefusedError,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import { retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { createAgentDatabaseExecutionCloser } from "./openclaw-agent-execution-close.js";
import type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseFileExecutionOpen,
  AgentDatabaseIncognitoOperations,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import {
  createAgentDatabaseDomainOwner,
  requestRestrictedAgentDatabaseAdmission,
  type AgentDatabaseAdmissionRestriction,
} from "./openclaw-agent-execution-domain.js";
import { createIncognitoAgentDatabaseBackend } from "./openclaw-agent-execution-incognito.worker.js";
import { createAgentDatabaseMaintenanceOwner } from "./openclaw-agent-execution-maintenance.js";
import {
  loadAgentTranscriptOperations,
  loadAgentReplacementOperations,
  loadAgentRestartRecoveryOperations,
  loadAgentEntryReadOperations,
  loadAgentEntryPatchOperations,
  loadAgentCompoundOperations,
  loadAgentNativeBindingOperations,
  loadAgentMessageCutOperations,
  prepareAgentNativeBindingOperation,
  loadAgentTrajectoryOperations,
  loadAgentArchiveOperations,
  loadAgentAcpOperations,
  loadAgentProviderReviewOperations,
  loadAgentReactionOperations,
  loadConversationDeliveryOperations,
  loadAgentPendingInputOperations,
  loadAgentArchivePruningOperations,
  loadUsageCacheOperations,
  prepareAgentTranscript,
  type RegisteredAgentWorkerOperations,
} from "./openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import {
  requireOpenClawStateDatabaseIdentity,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export function createSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string },
):
  | SqliteWorkerPreparedBackend<AgentDatabaseOperations>
  | SqliteWorkerPreparedBackend<AgentDatabaseIncognitoOperations> {
  if (input.kind === "ephemeral") {
    return createIncognitoAgentDatabaseBackend(input, opening);
  }
  const backend = openAgentDatabaseBackend(input, opening);
  try {
    backend.execute({ type: "database.prepareWrite", input: undefined });
    backend.assertSettled?.();
    return backend;
  } catch (error) {
    try {
      backend.closeAfterFailedOpen();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Agent creation and cleanup failed",
        error,
      );
    }
    throw error;
  }
}

/** The broker supplies a private admission channel before invoking this native factory. */
export const openExistingSqliteWorkerBackend: (
  input: AgentDatabaseFileExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
) => SqliteWorkerPreparedBackend<AgentDatabaseOperations> = openAgentDatabaseBackend;

function openAgentDatabaseBackend(
  input: AgentDatabaseFileExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> & { closeAfterFailedOpen(): void } {
  if (opening.databasePath !== input.databasePath) {
    throw new Error("Agent database open does not match its captured execution owner");
  }
  const admitOpen = () => {
    try {
      requestSqliteWorkerOperationAdmission({ stage: "open", facts: input });
    } catch (error) {
      throw new SqliteWorkerOpenRefusedError(error);
    }
  };
  admitOpen();
  const options = { agentId: input.agentId, path: input.databasePath, env: input.environment };
  let admittedFileIdentity =
    input.creatingIdentity?.key ??
    opening.existingIdentity ??
    readDatabasePathIdentitySync(input.databasePath).key;
  let admittedFileBirthtime = input.creatingIdentity?.birthtime;
  const assertFileIdentity = () => {
    if (input.expectedIdentity) {
      assertExistingDatabaseIdentity(
        input.databasePath,
        `file:${input.expectedIdentity.physicalIdentity}`,
        input.expectedIdentity.birthtime,
      );
    }
    const pathOnly = admittedFileIdentity.startsWith("path:");
    if (pathOnly || input.creatingIdentity) {
      const current = readDatabasePathIdentitySync(input.databasePath);
      if (
        (pathOnly && current.key !== admittedFileIdentity) ||
        (input.creatingIdentity && current.canonicalPath !== input.creatingIdentity.canonicalPath)
      ) {
        throw new Error("Agent database target changed before creating open");
      }
    }
    if (!pathOnly) {
      assertExistingDatabaseIdentity(
        input.databasePath,
        admittedFileIdentity,
        admittedFileBirthtime,
      );
    }
  };
  let database: OpenClawAgentDatabase | undefined;
  let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
  let sharedBorrow: ReturnType<typeof retainOpenClawStateDatabase> | undefined;
  let releaseBorrow: (() => void) | undefined;
  let identity: AgentDatabaseFileExecutionIdentity | undefined;
  let openingFailure: { error: unknown } | undefined;
  let startupJournalRequested = false;
  let publicationStartupJournal: boolean | undefined;
  const readRequestPreparation = () => {
    const attachment = takeSqliteWorkerOperationAdmissionAttachment();
    if (
      !isRecord(attachment) ||
      attachment.kind !== "agent-execution" ||
      typeof attachment.startupJournal !== "boolean"
    ) {
      throw new Error("Agent execution requires its request-local preparation facts");
    }
    return attachment.startupJournal;
  };
  const readDeletionJournal = () =>
    readAgentDeletionJournalStatusInDatabase(
      expectDefined(shared, "Agent execution shared-state owner").db,
      input.agentId,
    ) !== "absent";
  const openWriter = () => {
    let validation: OpenClawAgentDatabaseValidation | undefined;
    if (!database) {
      // Promotion needs the current command's source authority before any durable open work.
      admitOpen();
      assertFileIdentity();
      if (!shared) {
        shared = openOpenClawStateDatabase({
          path: input.stateDatabasePath,
          env: input.environment,
          initializationAgentPaths: [input.databasePath],
        });
        sharedBorrow = retainOpenClawStateDatabase(shared);
      }
      const lease = prepareOpenClawAgentDatabaseWorkerLease(options, shared, input.leaseId);
      const { port1, port2 } = new MessageChannel();
      try {
        requestSqliteWorkerOperationAdmission(
          {
            stage: "prepare",
            facts: {
              kind: "shared-owner",
              identity: requireOpenClawStateDatabaseIdentity(shared),
              lease: lease.receipt,
              validationPort: port2,
            },
          },
          [port2],
        );
        // The host posts before granting admission; shared revocation remains live after transfer.
        // SAFETY: this private port receives only the host's typed validation receipt.
        lease.validation = receiveMessageOnPort(port1)?.message as
          | OpenClawAgentDatabaseValidation
          | undefined;
      } catch (error) {
        throw new SqliteWorkerOpenRefusedError(error);
      } finally {
        port1.close();
        port2.close();
      }
      assertFileIdentity();
      let registration: OpenClawAgentDatabaseRegistrationCommit | undefined;
      let openingResult: Result<OpenClawAgentDatabase, unknown>;
      try {
        const opened = openOpenClawAgentDatabase(options, lease, {
          starting: () =>
            requestSqliteWorkerOperationAdmission({
              stage: "prepare",
              facts: { kind: "agent-registration-start", lease: lease.receipt },
            }),
          committed(receipt) {
            registration = receipt;
          },
        });
        database = opened;
        releaseBorrow = retainAgentDatabase(opened.db);
        openingResult = { ok: true, value: opened };
      } catch (error) {
        // The opener can retain a failed native handle before returning one to this actor.
        openingFailure = { error };
        openingResult = { ok: false, error };
      }
      if (registration) {
        try {
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { kind: "agent-registration-committed", registration },
          });
        } catch (error) {
          if (!openingResult.ok) {
            throw createSqliteLifecycleAggregateError(
              [openingResult.error, error],
              `${String(openingResult.error)}; committed registration reporting failed: ${String(error)}`,
              openingResult.error,
            );
          }
          throw error;
        }
      }
      if (!openingResult.ok) {
        throw openingResult.error;
      }
      const opened = openingResult.value;
      const nativeIdentity = readOpenClawAgentDatabaseIdentity(opened);
      if (typeof nativeIdentity.identity !== "string") {
        throw new Error("Disk agent execution requires its canonical file identity");
      }
      const openedFileIdentity = `file:${nativeIdentity.identity}`;
      if (
        admittedFileIdentity.startsWith("file:") &&
        (openedFileIdentity !== admittedFileIdentity ||
          (admittedFileBirthtime !== undefined &&
            nativeIdentity.birthtime !== admittedFileBirthtime))
      ) {
        throw new Error("Agent writer differs from its admitted physical file");
      }
      if (
        input.expectedIdentity &&
        nativeIdentity.identity !== input.expectedIdentity.physicalIdentity
      ) {
        throw new Error("Agent writer differs from its expected physical file");
      }
      admittedFileIdentity = openedFileIdentity;
      admittedFileBirthtime = nativeIdentity.birthtime;
      identity = {
        kind: "file",
        physicalIdentity: nativeIdentity.identity,
        birthtime: nativeIdentity.birthtime,
        incarnation: nativeIdentity.incarnation,
        nativeLocation: nativeIdentity.filename,
      };
      validation = getOpenClawAgentDatabaseValidation(opened);
    }
    if (!database || !database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Agent execution lost its retained native database");
    }
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: {
        identity,
        validation,
        ...(startupJournalRequested ? { agentDeletionJournalPresent: readDeletionJournal() } : {}),
      },
    });
    return database;
  };
  const admit = (
    stage: "transaction" | "commit",
    publication?: unknown,
    requestAdmission?: AgentDatabaseAdmissionRestriction,
  ) => {
    assertFileIdentity();
    const request: SqliteWorkerAdmissionRequest = {
      stage,
      facts: {
        identity,
        ...(startupJournalRequested ? { agentDeletionJournalPresent: readDeletionJournal() } : {}),
        ...(publication ? { publication } : {}),
      },
    };
    requestRestrictedAgentDatabaseAdmission(request, requestAdmission);
    if (stage === "commit") {
      ensureOpenClawAgentDatabasePermissions(input.databasePath, options);
    }
  };
  const writeTransaction = <T>(
    operationLabel: string,
    owner: string,
    write: (current: OpenClawAgentDatabase) => T,
  ): T => {
    const opened = openWriter();
    return runOpenClawAgentWriteTransaction(
      (current) => {
        if (current.db !== opened.db) {
          throw new Error(`${owner} lost its canonical database owner`);
        }
        admit("transaction");
        return write(current);
      },
      options,
      { operationLabel },
    );
  };
  const maintenance = createAgentDatabaseMaintenanceOwner({
    databaseOptions: options,
    assertFileIdentity,
    openWriter,
    admit,
  });
  const loadMaintenanceOperations = async () => maintenance.operations;
  const registry = createWorkerOperationRegistry<
    RegisteredAgentWorkerOperations,
    AgentWorkerOperationContext,
    keyof RegisteredAgentWorkerOperations
  >({
    "session.entry.read": loadAgentEntryReadOperations,
    "session.entry.patch.prepare": loadAgentEntryPatchOperations,
    "session.entry.patch.commit": loadAgentEntryPatchOperations,
    "session.turn.prepare": loadAgentCompoundOperations,
    "session.turn.commit": loadAgentCompoundOperations,
    "session.lifecycle.reset": loadAgentCompoundOperations,
    "session.lifecycle.project": loadAgentCompoundOperations,
    "session.nativeBindings.delete": loadAgentNativeBindingOperations,
    "session.messageCut.commit": loadAgentMessageCutOperations,
    "trajectory.events.append": loadAgentTrajectoryOperations,
    "trajectory.retention.delete": loadAgentTrajectoryOperations,
    "session.archives.preparePublication": loadAgentArchiveOperations,
    "session.archives.recordPublication": loadAgentArchiveOperations,
    "session.transcript.initialize": loadAgentTranscriptOperations,
    "session.entries.replace": loadAgentReplacementOperations,
    "session.restart.recover": loadAgentRestartRecoveryOperations,
    "session.entry.acp": loadAgentAcpOperations,
    "session.providerReview.compare": loadAgentProviderReviewOperations,
    "session.reaction.set": loadAgentReactionOperations,
    "conversation.delivery.begin": loadConversationDeliveryOperations,
    "conversation.delivery.transition": loadConversationDeliveryOperations,
    "session.pendingInputs.withdraw": loadAgentPendingInputOperations,
    "session.pendingInputs.read": loadAgentPendingInputOperations,
    "session.pendingInputs.mutate": loadAgentPendingInputOperations,
    "session.pendingInputs.interruptHistory": loadAgentPendingInputOperations,
    "session.archivePruning.deletePublished": loadAgentArchivePruningOperations,
    "session.archivePruning.pruneRetention": loadAgentArchivePruningOperations,
    "session.archivePruning.removeLegacy": loadAgentArchivePruningOperations,
    "session.archivePruning.reclaimPages": loadAgentArchivePruningOperations,
    "session.maintenance.prepare": loadMaintenanceOperations,
    "session.maintenance.metadata": loadMaintenanceOperations,
    "session.maintenance.release": loadMaintenanceOperations,
    "usageCache.writeRollup": loadUsageCacheOperations,
    "usageCache.prune": loadUsageCacheOperations,
    "usageCache.acquireLock": loadUsageCacheOperations,
    "usageCache.releaseLock": loadUsageCacheOperations,
  });
  const context: AgentWorkerOperationContext = {
    open: openWriter,
    options,
    admit,
    writeTransaction,
    writeSharedTransaction(source, write) {
      const retained = expectDefined(shared, "Native binding shared-state owner");
      const sharedIdentity = requireOpenClawStateDatabaseIdentity(retained);
      if (
        sharedIdentity.key !== source.key ||
        sharedIdentity.canonicalPath !== source.canonicalPath ||
        sharedIdentity.birthtime !== source.birthtime
      ) {
        throw new Error("Native binding settlement changed its captured shared-state owner");
      }
      assertExistingDatabaseIdentity(source.canonicalPath, source.key, source.birthtime);
      return runOpenClawStateWriteTransaction(
        write,
        { database: retained, path: retained.path, env: input.environment },
        { operationLabel: "session.native-binding.settlement" },
      );
    },
  };
  const domain = createAgentDatabaseDomainOwner({
    databasePath: input.databasePath,
    assertCurrent() {
      assertOpen();
      const current = openWriter();
      assertFileIdentity();
      return current.db;
    },
    assertCleanupCurrent() {
      if (
        !database ||
        !identity ||
        !database.db.isOpen ||
        normalizeDatabasePath(database.db.location() ?? "") !== identity.nativeLocation ||
        getOpenClawAgentDatabaseIfOpen(options) !== database
      ) {
        throw new Error("Agent cleanup lost its retained native database");
      }
      assertFileIdentity();
    },
    admit: (stage, requestAdmission) => admit(stage, undefined, requestAdmission),
  });
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Agent database execution owner is closed");
    }
  };
  const executeCommand = (command: SqliteWorkerCommand<AgentDatabaseOperations>) => {
    if (
      command.type === "database.domain.bind" ||
      command.type === "database.domain.publish" ||
      command.type === "database.domain.execute" ||
      command.type === "database.domain.close"
    ) {
      return domain.execute(command);
    }
    if (command.type === "database.prepareWrite") {
      openWriter();
      return undefined;
    }
    if (command.type === "database.walMaintenance") {
      return (
        openWriter().walMaintenance.maintainPeriodic?.(command.input, admit) ?? {
          reclaimedPages: 0,
        }
      );
    }
    return registry.execute(command, context);
  };
  return {
    ...createAgentDatabaseExecutionCloser(() => {
      closed = true;
      return {
        database,
        identity,
        releasePreparations: maintenance.getPreparationReleases(),
        closeDomain: () => domain.close(),
        releaseBorrow,
        sharedBorrow,
      };
    }),
    prepare(command) {
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.publish" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.prepare(command);
      }
      const preparing = registry.prepare(command.type);
      const nativeBindings =
        command.type === "session.nativeBindings.delete"
          ? command.input
          : command.type === "session.messageCut.commit"
            ? command.input.nativeBindings
            : undefined;
      if (nativeBindings) {
        return Promise.all([
          preparing,
          prepareAgentNativeBindingOperation(nativeBindings, input.environment),
        ]).then(() => {});
      }
      if (
        command.type === "session.maintenance.prepare" ||
        command.type === "session.maintenance.metadata"
      ) {
        return Promise.all([preparing, maintenance.prepare()]).then(() => {});
      }
      if (command.type === "session.entries.replace" && command.input.initializeTranscript) {
        return Promise.all([preparing, prepareAgentTranscript()]).then(() => {});
      }
      return preparing;
    },
    [SQLITE_WORKER_PREPARE_ADMITTED](command) {
      if (command.type !== "database.domain.publish") {
        return undefined;
      }
      publicationStartupJournal = readRequestPreparation();
      startupJournalRequested = publicationStartupJournal;
      try {
        return domain.preparePublication(command.input);
      } finally {
        startupJournalRequested = false;
      }
    },
    [SQLITE_WORKER_OPERATION_CLEANUP](command) {
      if (command.type === "session.maintenance.metadata") {
        maintenance.cleanup(command.input);
      }
      if (command.type === "database.domain.publish") {
        startupJournalRequested = publicationStartupJournal ?? false;
        try {
          domain.cleanupPublication(command.input.id);
        } finally {
          startupJournalRequested = false;
          publicationStartupJournal = undefined;
        }
      }
    },
    assertSettled() {
      if (openingFailure) {
        // A failed promotion requires native retirement, including custody retained by the opener.
        throw openingFailure.error;
      }
      domain.assertSettled();
      if (shared) {
        assertTransactionUsable(shared.db);
        if (!shared.db.isOpen || shared.db.isTransaction) {
          throw new Error("Agent database command left its shared-state participant unsettled");
        }
      }
      if (database) {
        assertTransactionUsable(database.db);
        if (!identity || !database.db.isOpen || database.db.isTransaction) {
          throw new Error("Agent database command left an unsettled native connection");
        }
      }
    },
    execute(command) {
      assertOpen();
      if (command.type === "database.domain.publish") {
        if (publicationStartupJournal === undefined) {
          throw new Error("Agent publication lost its request-local preparation facts");
        }
        startupJournalRequested = publicationStartupJournal;
      } else {
        startupJournalRequested = readRequestPreparation();
      }
      try {
        return executeCommand(command);
      } finally {
        startupJournalRequested = false;
      }
    },
  };
}

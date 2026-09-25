import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
} from "../infra/sqlite-wal-checkpoint.js";
import {
  SQLITE_WORKER_CLOSE_RECEIPT,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerCommand,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
  deferSqliteWorkerCommitReceipt,
  SqliteWorkerOpenRefusedError,
} from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
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
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseDomainOwner } from "./openclaw-agent-execution-domain.js";
import {
  requireOpenClawStateDatabaseIdentity,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

export function createSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string },
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> {
  const backend = openAgentDatabaseBackend(input, opening);
  try {
    backend.execute({ type: "database.prepareWrite", input: undefined });
    backend.assertSettled?.();
    return backend;
  } catch (error) {
    try {
      backend.close();
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
export function openExistingSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> {
  return openAgentDatabaseBackend(input, opening);
}

type AgentDatabaseNativeBackend = Omit<
  SqliteWorkerPreparedBackend<AgentDatabaseOperations>,
  "close"
> & {
  close(): void;
};

function openAgentDatabaseBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): AgentDatabaseNativeBackend {
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
  const preparedFileIdentity =
    input.creatingIdentity?.key ??
    opening.existingIdentity ??
    readDatabasePathIdentitySync(input.databasePath).key;
  let admittedFileIdentity = preparedFileIdentity;
  let admittedFileBirthtime = input.creatingIdentity?.birthtime;
  const assertFileIdentity = () => {
    if (input.expectedIdentity) {
      assertExistingDatabaseIdentity(
        input.databasePath,
        `file:${input.expectedIdentity.physicalIdentity}`,
        input.expectedIdentity.birthtime,
      );
    }
    if (admittedFileIdentity.startsWith("path:")) {
      const current = readDatabasePathIdentitySync(input.databasePath);
      if (
        current.key !== admittedFileIdentity ||
        (input.creatingIdentity && current.canonicalPath !== input.creatingIdentity.canonicalPath)
      ) {
        throw new Error("Agent database target changed before creating open");
      }
    } else {
      if (
        input.creatingIdentity &&
        readDatabasePathIdentitySync(input.databasePath).canonicalPath !==
          input.creatingIdentity.canonicalPath
      ) {
        throw new Error("Agent database target changed before creating open");
      }
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
  let identity: AgentDatabaseExecutionIdentity | undefined;
  let openingFailure: { error: unknown } | undefined;
  let startupJournalRequested = false;
  // This request-local flag is installed only for the synchronous native command below.
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
        const opened = openOpenClawAgentDatabase(options, lease, (receipt) => {
          registration = receipt;
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
  const admit = (stage: "transaction" | "commit", publication?: unknown) => {
    assertFileIdentity();
    requestSqliteWorkerOperationAdmission({
      stage,
      facts: {
        identity,
        ...(startupJournalRequested ? { agentDeletionJournalPresent: readDeletionJournal() } : {}),
        ...(publication ? { publication } : {}),
      },
    });
    if (stage === "commit") {
      ensureOpenClawAgentDatabasePermissions(input.databasePath, options);
    }
  };
  let providerReview:
    | typeof import("../config/sessions/provider-review-store.worker.js")
    | undefined;
  let entryReader:
    | typeof import("../config/sessions/session-accessor.sqlite-entry-read.js")
    | undefined;
  let archives:
    | typeof import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js")
    | undefined;
  let archivePruning:
    | typeof import("../config/sessions/session-history-archive-pruning.worker.js")
    | undefined;
  let transcript:
    | {
        initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
        assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      }
    | undefined;
  let replacements:
    | typeof import("../config/sessions/session-accessor.sqlite-replacement-state.js")
    | undefined;
  let trajectory: typeof import("../trajectory/runtime-store.sqlite.js") | undefined;
  const domain = createAgentDatabaseDomainOwner({
    databasePath: input.databasePath,
    assertCurrent() {
      assertOpen();
      const current = openWriter();
      assertFileIdentity();
      return current.db;
    },
    admit,
  });
  let closed = false;
  let closeReceipt: SqliteWorkerCloseReceipt | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Agent database execution owner is closed");
    }
  };
  const executeCommand = (command: SqliteWorkerCommand<AgentDatabaseOperations>) => {
    if (
      command.type === "database.domain.bind" ||
      command.type === "database.domain.execute" ||
      command.type === "database.domain.close"
    ) {
      return domain.execute(command);
    }
    if (command.type === "database.prepareWrite") {
      openWriter();
      return undefined;
    }
    if (command.type === "session.entry.read" && entryReader) {
      return entryReader.readSessionEntryRow(openWriter(), command.input.sessionKey)?.entry;
    }
    if (command.type === "trajectory.events.append" && trajectory) {
      const opened = openWriter();
      const append = trajectory.appendSqliteTrajectoryRuntimeEventsInTransaction;
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== opened.db) {
            throw new Error("Trajectory append lost its canonical database owner");
          }
          admit("transaction");
          append(current, command.input);
          deferSqliteWorkerCommitReceipt(current.db, { kind: "trajectory-runtime-append" });
          admit("commit");
        },
        options,
        { operationLabel: "trajectory.runtime.append" },
      );
    }
    if (
      (command.type === "session.archives.preparePublication" ||
        command.type === "session.archives.recordPublication") &&
      archives
    ) {
      const opened = openWriter();
      const kernel = archives;
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== opened.db) {
            throw new Error("Session archive publication lost its canonical database owner");
          }
          admit("transaction");
          const result =
            command.type === "session.archives.preparePublication"
              ? kernel.prepareSessionTranscriptArchivePublishPlans(current, command.input)
              : kernel.recordSessionTranscriptArchivePublishResults(
                  current,
                  command.input.results,
                  command.input.nowMs,
                );
          admit("commit");
          return result;
        },
        options,
        { operationLabel: "session.archive.publish" },
      );
    }
    if (command.type === "session.transcript.initialize" && transcript) {
      const assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity =
        transcript.assertIdentity;
      assertIdentity(command.input);
      const initialize = transcript.initialize;
      const opened = openWriter();
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== opened.db) {
            throw new Error("Session transcript lost its canonical database owner");
          }
          admit("transaction");
          const publication: SessionTranscriptInitializationPublication = {
            kind: "session-transcript-initialized",
            sessionKey: command.input.sessionKey,
          };
          initialize(
            current,
            { agentId: input.agentId, path: input.databasePath, ...command.input },
            command.input.cwd,
            {
              onPlaceholderInserted: ({ sessionId }) => {
                publication.placeholder = { sessionId };
              },
            },
          );
          deferSqliteWorkerCommitReceipt(current.db, publication);
          admit("commit", publication);
          return publication;
        },
        options,
        { operationLabel: "session.entry.create-with-transcript" },
      );
    }
    if (command.type === "session.entries.replace" && replacements) {
      const opened = openWriter();
      const replace = replacements.commitSessionEntryReplacementsInDatabase;
      const preparePublication = replacements.prepareSessionEntryReplacementPublication;
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== opened.db) {
            throw new Error("Session replacement lost its canonical database owner");
          }
          admit("transaction");
          const result = replace(current, command.input, () => {});
          const publication = preparePublication(result);
          deferSqliteWorkerCommitReceipt(current.db, publication);
          admit("commit", publication);
          return result;
        },
        options,
        { operationLabel: "session.entry-replacements" },
      );
    }
    if (command.type === "session.providerReview.compare" && providerReview) {
      return providerReview.compareSessionProviderReviewInWorker(
        openWriter(),
        options,
        command.input,
        admit,
      );
    }
    if (command.type === "session.archivePruning.deletePublished" && archivePruning) {
      return archivePruning.deletePublishedSessionArchiveInDatabase(
        openWriter(),
        options,
        command.input,
        admit,
      );
    }
    if (command.type === "session.archivePruning.removeLegacy" && archivePruning) {
      return archivePruning.removeLegacySessionArchiveInDatabase(
        openWriter(),
        options,
        command.input.filePath,
        admit,
      );
    }
    if (command.type === "session.archivePruning.reclaimPages" && archivePruning) {
      return archivePruning.reclaimSessionArchivePagesInWorker(
        openWriter(),
        command.input.maxPages,
        admit,
      );
    }
    throw new Error("Unknown agent database operation");
  };
  return {
    prepare(command) {
      if (command.type === "session.entry.read") {
        return import("../config/sessions/session-accessor.sqlite-entry-read.js").then((module) => {
          entryReader = module;
        });
      }
      if (command.type === "trajectory.events.append") {
        return import("../trajectory/runtime-store.sqlite.js").then((module) => {
          trajectory = module;
        });
      }
      if (
        command.type === "session.archives.preparePublication" ||
        command.type === "session.archives.recordPublication"
      ) {
        return import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js").then(
          (module) => {
            archives = module;
          },
        );
      }
      if (
        command.type === "session.archivePruning.deletePublished" ||
        command.type === "session.archivePruning.removeLegacy" ||
        command.type === "session.archivePruning.reclaimPages"
      ) {
        return import("../config/sessions/session-history-archive-pruning.worker.js").then(
          (module) => {
            archivePruning = module;
          },
        );
      }
      if (command.type === "session.transcript.initialize") {
        return Promise.all([
          import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
          import("../config/sessions/session-accessor.sqlite-scope.js"),
        ]).then(([header, scope]) => {
          transcript = {
            initialize: header.ensureTranscriptHeader,
            assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
          };
        });
      }
      if (command.type === "session.entries.replace") {
        return import("../config/sessions/session-accessor.sqlite-replacement-state.js").then(
          (module) => {
            replacements = module;
          },
        );
      }
      if (command.type === "session.providerReview.compare") {
        return import("../config/sessions/provider-review-store.worker.js").then((module) => {
          providerReview = module;
        });
      }
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.prepare(command);
      }
      return undefined;
    },
    assertSettled() {
      if (openingFailure) {
        // A failed promotion requires native retirement, including custody retained by the opener.
        throw openingFailure.error;
      }
      domain.assertSettled();
      if (database) {
        assertTransactionUsable(database.db);
        if (!identity || !database.db.isOpen || database.db.isTransaction) {
          throw new Error("Agent database command left an unsettled native connection");
        }
      }
    },
    execute(command) {
      assertOpen();
      const attachment = takeSqliteWorkerOperationAdmissionAttachment();
      if (
        !isRecord(attachment) ||
        attachment.kind !== "agent-execution" ||
        typeof attachment.startupJournal !== "boolean"
      ) {
        throw new Error("Agent execution requires its request-local preparation facts");
      }
      startupJournalRequested = attachment.startupJournal;
      try {
        return executeCommand(command);
      } finally {
        startupJournalRequested = false;
      }
    },
    [SQLITE_WORKER_CLOSE_RECEIPT]() {
      return closeReceipt;
    },
    close() {
      closed = true;
      closeReceipt = undefined;
      let checkpoint: SqliteWalCheckpointSnapshot | undefined;
      const errors: unknown[] = [];
      for (const cleanup of [
        () => domain.close(),
        () => {
          if (!database) {
            return;
          }
          const closingPath = sqliteReaderDatabasePathKey(database.path);
          const stopObserving = onSqliteWalCheckpoint((observation) => {
            if (observation.databasePath === closingPath) {
              checkpoint = {
                health: observation.health,
                observedAtNs: observation.observedAtNs,
              };
            }
          });
          try {
            closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
          } finally {
            stopObserving();
          }
        },
        () => releaseBorrow?.(),
        () => sharedBorrow?.release(),
      ]) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Agent database cleanup failed",
          errors[0],
        );
      }
      if (identity && checkpoint) {
        closeReceipt = {
          identity: {
            key: `file:${identity.physicalIdentity}`,
            canonicalPath: identity.nativeLocation,
          },
          incarnation: identity.incarnation,
          checkpoint,
        };
      }
    },
  };
}

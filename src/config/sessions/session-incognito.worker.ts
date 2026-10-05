import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-store.js";
import {
  isIncognitoSessionKey,
  resolveIncognitoSessionExpiresAt,
} from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseIncognitoIdentity } from "../../state/openclaw-agent-execution-contract.js";
import {
  requestRestrictedAgentDatabaseAdmission,
  type AgentDatabaseAdmissionRestriction,
} from "../../state/openclaw-agent-execution-domain.js";
import { assertSessionCreationLabelAvailable } from "./session-accessor.sqlite-creation-read.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import {
  isIncognitoComputeCommand,
  isIncognitoComputeWrite,
} from "./session-incognito-compute-contract.js";
import { createIncognitoComputeWorker } from "./session-incognito-compute.worker.js";
import type {
  IncognitoSessionOperations,
  IncognitoSessionSnapshot,
} from "./session-incognito-contract.js";
import { isIncognitoHistoryCommand } from "./session-incognito-history-contract.js";
import { createIncognitoHistoryWorker } from "./session-incognito-history.worker.js";
import {
  incognitoLifecycleKeys,
  isIncognitoLifecycleCommand,
  isIncognitoLifecycleWrite,
} from "./session-incognito-lifecycle-contract.js";
import { createIncognitoLifecycleWorker } from "./session-incognito-lifecycle.worker.js";
import {
  isIncognitoManagerCommand,
  isIncognitoManagerWrite,
} from "./session-incognito-manager-contract.js";
import { createIncognitoManagerWorker } from "./session-incognito-manager.worker.js";
import { isIncognitoOutboxCommand } from "./session-incognito-outbox-contract.js";
import { createIncognitoOutboxWorker } from "./session-incognito-outbox.worker.js";
import {
  incognitoSideDataKeys,
  isIncognitoSideDataWrite,
} from "./session-incognito-side-data-contract.js";
import { createIncognitoSideDataWorker } from "./session-incognito-side-data.worker.js";
import {
  isIncognitoTranscriptCommand,
  isIncognitoTranscriptWrite,
} from "./session-incognito-transcript-contract.js";
import { createIncognitoTranscriptWorker } from "./session-incognito-transcript.worker.js";
import { interruptPendingInputHistoryInDatabase } from "./session-pending-input-history-reconcile.js";
import type {
  PendingInputHistoryGrant,
  PendingInputHistoryReceipt,
} from "./session-pending-input-history.types.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutationReceipt,
} from "./session-pending-input-operations.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

/** Connection-bound kernels: no namespace lookup, second connection, or shared-state write. */
export function createIncognitoSessionWorker(
  database: OpenClawAgentDatabase,
  identity: AgentDatabaseIncognitoIdentity,
  env: SqliteWorkerStateContext["environment"],
) {
  let revision = 0;
  const read = (sessionKey: string): IncognitoSessionSnapshot => {
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    return {
      entry,
      facts: [
        {
          identity,
          sessionKey,
          revision,
          sharing: entry
            ? {
                entry: projectSessionSharingEntry(entry),
                membership: new Set(
                  listSessionMembersInDatabase(database, sessionKey).map(
                    (member) => member.identityId,
                  ),
                ),
              }
            : undefined,
          expiresAt: entry ? resolveIncognitoSessionExpiresAt(entry) : undefined,
        },
      ],
    };
  };
  const assertKey = (sessionKey: string) => {
    assertCanonicalSessionKeyWrite(sessionKey, database.agentId);
    if (!isIncognitoSessionKey(sessionKey)) {
      throw new Error("Incognito actor requires an incognito session key");
    }
  };
  const admit = (
    stage: "transaction" | "commit",
    keys: readonly string[],
    pendingInput?: {
      custody: PendingInputHistoryGrant | PendingInputCustodyGrant;
      receipt?: PendingInputHistoryReceipt | PendingInputMutationReceipt;
    },
    restriction?: AgentDatabaseAdmissionRestriction,
  ) => {
    keys.forEach(assertKey);
    const facts = keys.flatMap((key) => read(key).facts);
    if (stage === "commit") {
      const nextRevision = revision + 1;
      facts.forEach((fact) => {
        fact.revision = nextRevision;
      });
      stageSqliteTransactionState(database.db, {
        stage() {},
        rollback() {},
        commit() {
          revision = nextRevision;
        },
      });
      deferSqliteWorkerCommitReceipt(
        database.db,
        pendingInput?.receipt ? { value: pendingInput.receipt, facts } : facts,
      );
    }
    requestRestrictedAgentDatabaseAdmission(
      { stage, facts: { identity, sessions: facts, pendingInput: pendingInput?.custody } },
      restriction,
    );
  };
  const sideData = createIncognitoSideDataWorker(database, env, admit);
  const transcript = createIncognitoTranscriptWorker(database, env, admit);
  const manager = createIncognitoManagerWorker(database, env, (stage, keys, restriction) =>
    admit(stage, keys, undefined, restriction),
  );
  const outbox = createIncognitoOutboxWorker(database, admit);
  const lifecycle = createIncognitoLifecycleWorker(database, identity, env, admit);
  const history = createIncognitoHistoryWorker(database, env);
  const compute = createIncognitoComputeWorker(database, env, admit);
  const readOnly = <T>(operation: () => T): T => {
    // sqlite-allow-raw -- Guard reads on the retained writable memory connection.
    database.db.exec("PRAGMA query_only = ON");
    try {
      return runSqliteReadOperationSync(database.db, operation);
    } finally {
      // sqlite-allow-raw -- Restore the writer after the read scope has settled.
      database.db.exec("PRAGMA query_only = OFF");
    }
  };
  return {
    async prepare(command: SqliteWorkerCommand<IncognitoSessionOperations>) {
      if (isIncognitoManagerCommand(command)) {
        await manager.prepare();
      } else if (isIncognitoComputeCommand(command)) {
        await compute.prepare(command);
      } else if (isIncognitoHistoryCommand(command)) {
        await history.prepare(command);
      } else if (isIncognitoTranscriptCommand(command)) {
        await transcript.prepare(command);
      } else if (isIncognitoOutboxCommand(command)) {
        await outbox.prepare(command);
      } else if (
        !isIncognitoLifecycleCommand(command) &&
        command.type !== "session.pendingInputs.read" &&
        command.type !== "session.pendingInputs.mutate" &&
        command.type !== "session.pendingInputs.interruptHistory" &&
        command.type !== "session.entry.create" &&
        command.type !== "session.entry.read"
      ) {
        await sideData.prepare(command);
      }
    },
    execute(command: SqliteWorkerCommand<IncognitoSessionOperations>) {
      if (command.type === "session.pendingInputs.read") {
        const { sessionKey } = command.input;
        assertKey(sessionKey);
        return readOnly(() => {
          const facts = read(sessionKey).facts;
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { identity, sessions: facts },
          });
          return { value: readPendingInput(database, command.input), facts };
        });
      }
      if (command.type === "session.pendingInputs.mutate") {
        const { sessionKey } = command.input;
        assertKey(sessionKey);
        let receipt: PendingInputMutationReceipt | undefined;
        const value = mutatePendingInput(
          command.input,
          {
            writeTransaction: (operationLabel, _owner, run) =>
              runOpenClawAgentWriteTransaction(
                (current) => {
                  if (current.db !== database.db) {
                    throw new Error("Incognito pending input lost its native owner");
                  }
                  return run(current);
                },
                { agentId: database.agentId, path: database.path, env },
                { operationLabel },
              ),
            admit: (stage, custody) => {
              // SAFETY: This same paired kernel supplies the typed grant to the durable writer.
              admit(stage, [sessionKey], { custody: custody as PendingInputCustodyGrant, receipt });
            },
          },
          (_db, committed) => {
            receipt = committed;
          },
        );
        return { value, facts: read(sessionKey).facts };
      }
      if (isIncognitoManagerCommand(command)) {
        assertKey(command.input.sessionKey);
        const execute = () => {
          const { value, keys } = manager.execute(command);
          return { value, facts: keys.flatMap((key) => read(key).facts) };
        };
        return isIncognitoManagerWrite(command.type)
          ? execute()
          : readOnly(() => {
              requestSqliteWorkerOperationAdmission({
                stage: "prepare",
                facts: { identity, sessions: read(command.input.sessionKey).facts },
              });
              return execute();
            });
      }
      if (command.type === "session.pendingInputs.interruptHistory") {
        const { sessionKey, sessionId, lifecycleRevision, ids } = command.input;
        assertKey(sessionKey);
        let receipt: PendingInputHistoryReceipt | undefined;
        const value = interruptPendingInputHistoryInDatabase(
          database,
          { agentId: database.agentId, path: database.path, env },
          { sessionKey, sessionId, ids },
          (stage, custody) => {
            const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
            if (entry?.sessionId !== sessionId || entry.lifecycleRevision !== lifecycleRevision) {
              throw new Error("Incognito pending input session generation is no longer current");
            }
            admit(stage, [sessionKey], { custody, receipt });
          },
          (committed) => {
            receipt = committed;
          },
        );
        return { value, facts: read(sessionKey).facts };
      }
      if (isIncognitoComputeCommand(command)) {
        assertKey(command.input.sessionKey);
        const execute = () => {
          const { value, keys } = compute.execute(command);
          return { value, facts: keys.flatMap((key) => read(key).facts) };
        };
        if (isIncognitoComputeWrite(command.type)) {
          return execute();
        }
        return readOnly(() => {
          const facts = read(command.input.sessionKey).facts;
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { identity, sessions: facts },
          });
          return execute();
        });
      }
      if (isIncognitoHistoryCommand(command)) {
        assertKey(command.input.sessionKey);
        return readOnly(() => {
          const facts = read(command.input.sessionKey).facts;
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { identity, sessions: facts },
          });
          return history.execute(command, facts);
        });
      }
      if (isIncognitoLifecycleCommand(command)) {
        incognitoLifecycleKeys(command, identity).forEach(assertKey);
        const execute = () => {
          const { value, keys } = lifecycle.execute(command);
          keys.forEach(assertKey);
          return { value, facts: keys.flatMap((key) => read(key).facts) };
        };
        return isIncognitoLifecycleWrite(command.type) ? execute() : readOnly(execute);
      }
      if (isIncognitoTranscriptCommand(command) || isIncognitoOutboxCommand(command)) {
        assertKey(command.input.sessionKey);
        const execute = () => {
          const { keys, ...result } = isIncognitoTranscriptCommand(command)
            ? transcript.execute(command)
            : outbox.execute(command);
          return { ...result, facts: keys.flatMap((key) => read(key).facts) };
        };
        return isIncognitoTranscriptCommand(command) && !isIncognitoTranscriptWrite(command.type)
          ? readOnly(execute)
          : execute();
      }
      if (command.type !== "session.entry.create" && command.type !== "session.entry.read") {
        const keys = incognitoSideDataKeys(command);
        keys.forEach(assertKey);
        const execute = () => {
          const { keys: resultKeys, ...result } = sideData.execute(command, keys);
          return { ...result, facts: resultKeys.flatMap((key) => read(key).facts) };
        };
        return isIncognitoSideDataWrite(command.type) ? execute() : readOnly(execute);
      }
      const { sessionKey } = command.input;
      assertKey(sessionKey);
      if (command.type === "session.entry.read") {
        return readOnly(() => {
          const snapshot = read(sessionKey);
          const expected = command.input.expected;
          if (
            expected &&
            (snapshot.entry?.sessionId !== expected.sessionId ||
              snapshot.entry.lifecycleRevision !== expected.lifecycleRevision)
          ) {
            throw new Error("Incognito session generation is no longer current");
          }
          return snapshot;
        });
      }
      const result = runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Incognito creation lost its native owner");
          }
          const before = read(sessionKey);
          admit("transaction", [sessionKey]);
          if (before.entry) {
            if (
              before.entry.sessionId !== command.input.entry.sessionId ||
              before.entry.lifecycleRevision !== command.input.entry.lifecycleRevision
            ) {
              throw new Error("Incognito session already exists with another generation");
            }
          } else {
            assertSessionCreationLabelAvailable(database, sessionKey, command.input.entry.label);
            const entry = writeSessionEntry(database, sessionKey, {
              ...command.input.entry,
              incognito: true,
            });
            ensureTranscriptHeader(
              database,
              {
                agentId: database.agentId,
                path: database.path,
                sessionKey,
                sessionId: entry.sessionId,
              },
              command.input.cwd,
            );
          }
          admit("commit", [sessionKey]);
          return read(sessionKey);
        },
        { agentId: database.agentId, path: database.path, env },
        { operationLabel: "session.entry.create-with-transcript" },
      );
      result.facts.forEach((fact) => {
        fact.revision = revision;
      });
      return result;
    },
    assertSettled() {
      manager.assertSettled();
      compute.assertSettled();
      history.assertSettled();
      sideData.assertSettled();
      transcript.assertSettled();
      outbox.assertSettled();
    },
    close() {
      manager.close();
      compute.close();
      sideData.close();
      transcript.close();
      outbox.close();
    },
  };
}

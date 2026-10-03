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
import { assertSessionCreationLabelAvailable } from "./session-accessor.sqlite-creation-read.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type {
  IncognitoSessionOperations,
  IncognitoSessionSnapshot,
} from "./session-incognito-contract.js";
import {
  incognitoLifecycleKeys,
  isIncognitoLifecycleCommand,
  isIncognitoLifecycleWrite,
} from "./session-incognito-lifecycle-contract.js";
import { createIncognitoLifecycleWorker } from "./session-incognito-lifecycle.worker.js";
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
  const admit = (stage: "transaction" | "commit", keys: readonly string[]) => {
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
      deferSqliteWorkerCommitReceipt(database.db, facts);
    }
    requestSqliteWorkerOperationAdmission({ stage, facts: { identity, sessions: facts } });
  };
  const sideData = createIncognitoSideDataWorker(database, env, admit);
  const transcript = createIncognitoTranscriptWorker(database, env, admit);
  const outbox = createIncognitoOutboxWorker(database, admit);
  const lifecycle = createIncognitoLifecycleWorker(database, identity, env, admit);
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
      if (isIncognitoTranscriptCommand(command)) {
        await transcript.prepare(command);
      } else if (isIncognitoOutboxCommand(command)) {
        await outbox.prepare(command);
      } else if (
        !isIncognitoLifecycleCommand(command) &&
        command.type !== "session.entry.create" &&
        command.type !== "session.entry.read"
      ) {
        await sideData.prepare(command);
      }
    },
    execute(command: SqliteWorkerCommand<IncognitoSessionOperations>) {
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
          const result = sideData.execute(command, keys);
          return { value: result.value, facts: result.keys.flatMap((key) => read(key).facts) };
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
      sideData.assertSettled();
      transcript.assertSettled();
      outbox.assertSettled();
    },
    close() {
      sideData.close();
      transcript.close();
      outbox.close();
    },
  };
}

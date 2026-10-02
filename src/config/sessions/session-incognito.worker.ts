import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
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
  IncognitoSessionFacts,
  IncognitoSessionOperations,
  IncognitoSessionSnapshot,
} from "./session-incognito-contract.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

/** Connection-bound kernels: no namespace lookup, second connection, or shared-state write. */
export function createIncognitoSessionWorker(
  database: OpenClawAgentDatabase,
  identity: AgentDatabaseIncognitoIdentity,
  env: NodeJS.ProcessEnv,
) {
  let revision = 0;
  const read = (sessionKey: string): IncognitoSessionSnapshot => {
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    return {
      entry,
      facts: {
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
    };
  };
  const admit = (stage: "transaction" | "commit", facts: IncognitoSessionFacts) =>
    requestSqliteWorkerOperationAdmission({ stage, facts: { identity, session: facts } });
  return (command: SqliteWorkerCommand<IncognitoSessionOperations>) => {
    const { sessionKey } = command.input;
    assertCanonicalSessionKeyWrite(sessionKey, database.agentId);
    if (!isIncognitoSessionKey(sessionKey)) {
      throw new Error("Incognito actor requires an incognito session key");
    }
    if (command.type === "session.entry.read") {
      // sqlite-allow-raw -- Guard reads on the retained writable memory connection.
      database.db.exec("PRAGMA query_only = ON");
      try {
        return runSqliteReadOperationSync(database.db, () => {
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
      } finally {
        // sqlite-allow-raw -- Restore the writer only after the read scope has settled.
        database.db.exec("PRAGMA query_only = OFF");
      }
    }
    const result = runOpenClawAgentWriteTransaction(
      (current) => {
        if (current.db !== database.db) {
          throw new Error("Incognito creation lost its native owner");
        }
        const before = read(sessionKey);
        admit("transaction", before.facts);
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
        const snapshot = read(sessionKey);
        snapshot.facts.revision = revision + 1;
        stageSqliteTransactionState(database.db, {
          stage() {},
          rollback() {},
          commit() {
            revision = snapshot.facts.revision;
          },
        });
        deferSqliteWorkerCommitReceipt(database.db, snapshot.facts);
        admit("commit", snapshot.facts);
        return snapshot;
      },
      { agentId: database.agentId, path: database.path, env },
      { operationLabel: "session.entry.create-with-transcript" },
    );
    return result;
  };
}

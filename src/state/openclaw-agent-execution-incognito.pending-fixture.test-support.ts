import assert from "node:assert/strict";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { SqliteWorkerEphemeralTarget } from "../infra/sqlite-worker-contract.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseIncognitoOpen } from "./openclaw-agent-execution-contract.js";
import { createIncognitoAgentDatabaseBackend } from "./openclaw-agent-execution-incognito.worker.js";

/** Only boot fixtures differ; every command uses the real actor backend and admission. */
export async function createSqliteWorkerBackend(
  input: AgentDatabaseIncognitoOpen,
  opening: { databasePath: string; target?: SqliteWorkerEphemeralTarget },
) {
  const backend = createIncognitoAgentDatabaseBackend(input, opening);
  try {
    const database = getOpenClawAgentDatabaseIfOpen({
      agentId: input.agentId,
      path: input.databasePath,
      env: input.environment,
    });
    assert(database);
    runOpenClawAgentWriteTransaction(
      () => {
        for (const name of ["page", "transaction", "commit", "lost", "close"]) {
          const sessionId = `pending-${name}`;
          const sessionKey = `agent:${input.agentId}:dashboard:incognito-${sessionId}`;
          writeSessionEntry(database, sessionKey, {
            sessionId,
            lifecycleRevision: "initial",
            createdAt: 10_000,
            updatedAt: 10_000,
            incognito: true,
          });
          const rows = name === "page" ? ["first", "second", "third"] : ["first", "second"];
          for (const [index, suffix] of rows.entries()) {
            const id = `${name}-${suffix}`;
            executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .insertInto("session_pending_inputs")
                .values({
                  input_id: id,
                  session_key: sessionKey,
                  session_id: sessionId,
                  idempotency_key: `${id}:user`,
                  run_id: id,
                  request_hash: `synthetic-${id}`,
                  message_json: JSON.stringify({
                    role: "user",
                    content: `Synthetic ${id}`,
                    timestamp: 10_000 + index,
                    idempotencyKey: `${id}:user`,
                  }),
                  lifecycle_generation: input.identity.incarnation,
                  state: "queued",
                  accepted_at: 10_000 + index,
                  consumed_event_id: null,
                }),
            );
          }
        }
      },
      { agentId: input.agentId, path: input.databasePath, env: input.environment },
    );
    return backend;
  } catch (error) {
    await backend.close();
    throw error;
  }
}

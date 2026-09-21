import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
import type {
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionIdentity,
} from "./session-attachment.js";

type AttachmentTable = {
  session_id: string;
  session_key: string;
  agent_id: string;
  session_lifecycle_revision: string | null;
  environment_id: string;
  generation: number;
  created_at_ms: number;
  last_used_at_ms: number;
  closed_at_ms: number | null;
};
type AttachmentDatabase = Pick<StateDatabase, "worker_environments"> & {
  worker_environment_session_attachments: AttachmentTable;
};
const query = (db: DatabaseSync) => getNodeSqliteKysely<AttachmentDatabase>(db);

export const WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_environment_session_attachments (
  session_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_lifecycle_revision TEXT,
  environment_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS worker_environment_session_attachments_session_key
ON worker_environment_session_attachments(agent_id, session_key);
`;

function fromRow(row: Selectable<AttachmentTable>): WorkerEnvironmentAttachmentRecord {
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    ...(row.session_lifecycle_revision
      ? { sessionLifecycleRevision: row.session_lifecycle_revision }
      : {}),
    environmentId: row.environment_id,
    generation: row.generation,
    createdAtMs: row.created_at_ms,
    lastUsedAtMs: row.last_used_at_ms,
    closedAtMs: row.closed_at_ms,
  };
}

function get(db: DatabaseSync, sessionId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environment_session_attachments")
      .selectAll()
      .where("session_id", "=", sessionId),
  );
  return row ? fromRow(row) : undefined;
}

export function hasWorkerEnvironmentSessionAttachment(
  db: DatabaseSync,
  environmentId: string,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_environment_session_attachments")
        .select("session_id")
        .where("environment_id", "=", environmentId),
    ),
  );
}

export function createWorkerEnvironmentSessionAttachmentStore(options: {
  path: string;
  read: () => DatabaseSync;
  write: <T>(operation: (db: DatabaseSync) => T) => T;
  now: () => number;
  createIntent: (db: DatabaseSync, input: WorkerEnvironmentIntentInput) => WorkerEnvironmentRecord;
  getEnvironment: (db: DatabaseSync, environmentId: string) => WorkerEnvironmentRecord | undefined;
}) {
  const { read, write, now } = options;
  const assertIdentity = (
    record: WorkerEnvironmentAttachmentRecord,
    expected: WorkerEnvironmentSessionIdentity,
  ) => {
    if (
      record.sessionId !== expected.sessionId ||
      record.sessionKey !== expected.sessionKey ||
      record.agentId !== expected.agentId
    ) {
      throw new Error("Conversation environment identity changed");
    }
  };
  return {
    async hasSessionAttachment(environmentId: string): Promise<boolean> {
      const reply = await executeExistingOpenClawStateRead(
        { path: options.path },
        { type: "workerEnvironments.hasSessionAttachment", environmentId },
      );
      if (!reply?.ok || reply.type !== "workerEnvironments.hasSessionAttachment") {
        throw new Error("Conversation environment attachment read is unavailable");
      }
      return reply.attached;
    },
    getSessionAttachmentRecord: (sessionId: string) => get(read(), sessionId),
    listSessionAttachmentRecords: () => {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db).selectFrom("worker_environment_session_attachments").selectAll(),
      ).rows.map(fromRow);
    },
    findSessionAttachmentRecord(
      identity: Pick<WorkerEnvironmentSessionIdentity, "agentId" | "sessionKey">,
    ) {
      const db = read();
      const rows = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_environment_session_attachments")
          .selectAll()
          .where("agent_id", "=", identity.agentId)
          .where("session_key", "=", identity.sessionKey)
          .where("closed_at_ms", "is", null),
      ).rows;
      return rows.length === 1 ? fromRow(rows[0]!) : undefined;
    },
    createSessionAttachmentIntent(
      input: WorkerEnvironmentIntentInput & WorkerEnvironmentSessionIdentity,
      assertCurrent: () => void,
    ) {
      return write((db) => {
        assertCurrent();
        const previous = get(db, input.sessionId);
        if (previous) {
          assertIdentity(previous, input);
          const environment = options.getEnvironment(db, previous.environmentId);
          if (environment && !["destroyed", "failed"].includes(environment.state)) {
            throw new Error(
              "Conversation already owns a worker environment; stop it before replacing it",
            );
          }
          if (previous.environmentId === input.environmentId) {
            throw new Error(
              "This environment request was already stopped; use a new idempotency key",
            );
          }
        }
        const environment = options.createIntent(db, input);
        if (environment.state !== "requested") {
          throw new Error("Environment request already belongs to an earlier allocation");
        }
        const at = now();
        executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_environment_session_attachments")
            .values({
              session_id: input.sessionId,
              session_key: input.sessionKey,
              agent_id: input.agentId,
              session_lifecycle_revision: input.sessionLifecycleRevision ?? null,
              environment_id: input.environmentId,
              generation: (previous?.generation ?? 0) + 1,
              created_at_ms: at,
              last_used_at_ms: at,
              closed_at_ms: null,
            })
            .onConflict((oc) =>
              oc.column("session_id").doUpdateSet({
                environment_id: input.environmentId,
                generation: (previous?.generation ?? 0) + 1,
                session_lifecycle_revision: input.sessionLifecycleRevision ?? null,
                created_at_ms: at,
                last_used_at_ms: at,
                closed_at_ms: null,
              }),
            ),
        );
        return { attachment: get(db, input.sessionId)!, environment };
      });
    },
    closeSessionAttachment(sessionId: string, assertCurrent: () => void = () => {}) {
      return write((db) => {
        assertCurrent();
        const current = get(db, sessionId);
        if (!current || current.closedAtMs !== null) {
          return current;
        }
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environment_session_attachments")
            .set({ closed_at_ms: now() })
            .where("session_id", "=", sessionId),
        );
        return get(db, sessionId);
      });
    },
    cancelSessionAttachmentReservation(record: WorkerEnvironmentAttachmentRecord) {
      write((db) => {
        const current = get(db, record.sessionId);
        const environment = options.getEnvironment(db, record.environmentId);
        if (
          !current ||
          current.environmentId !== record.environmentId ||
          current.generation !== record.generation ||
          !environment ||
          environment.state !== "requested" ||
          environment.leaseId !== null
        ) {
          throw new Error("Conversation environment reservation changed before cancellation");
        }
        const at = now();
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environment_session_attachments")
            .set({ closed_at_ms: current.closedAtMs ?? at })
            .where("session_id", "=", current.sessionId),
        );
        // Closing and cancelling the intent commit together: recovery must never allocate an
        // environment whose required requester presentation was rejected before provisioning.
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environments")
            .set({
              destroy_requested_at_ms: environment.destroyRequestedAtMs ?? at,
              teardown_terminal_state: "destroyed",
              updated_at_ms: at,
            })
            .where("environment_id", "=", environment.environmentId)
            .where("state", "=", "requested"),
        );
      });
    },
    touchSessionAttachment(record: WorkerEnvironmentAttachmentRecord, assertCurrent: () => void) {
      write((db) => {
        assertCurrent();
        const current = get(db, record.sessionId);
        if (
          !current ||
          current.environmentId !== record.environmentId ||
          current.generation !== record.generation ||
          current.closedAtMs !== null
        ) {
          throw new Error("Conversation environment attachment is no longer current");
        }
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environment_session_attachments")
            .set({ last_used_at_ms: now() })
            .where("session_id", "=", record.sessionId),
        );
      });
    },
  };
}

import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

/** Retain canonical target facts independently of the listing cache's invalidation lifecycle. */
export function captureSessionEntryRead(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sessionKey: string,
) {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const capture = () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      // Entry, owner, and participant projections must come from one committed snapshot.
      const selected = readExactSessionEntryRow(database, sessionKey, "list");
      return selected
        ? {
            entry: selected.entry,
            agentId: database.agentId,
            sessionKey: selected.row.session_key,
            rowid: selected.row.rowid,
            sessionId: selected.row.current_session_id,
            updatedAt: selected.row.updated_at,
            lifecycleRevision: selected.entry.lifecycleRevision,
            // Read acknowledgments do not change metadata or session authority.
            digest: sha256Hex(JSON.stringify({ ...selected.entry, lastReadAt: undefined })),
          }
        : undefined;
    });
  const selected = capture();
  let released = false;
  return {
    entry: selected?.entry,
    isCurrent: () => {
      if (released || !database.db.isOpen) {
        return false;
      }
      const current = capture();
      if (!selected || !current) {
        return selected === current;
      }
      // Recreating identical canonical facts is current even if SQLite assigns another rowid.
      return (
        current.agentId === selected.agentId &&
        current.sessionKey === selected.sessionKey &&
        current.sessionId === selected.sessionId &&
        current.updatedAt === selected.updatedAt &&
        current.lifecycleRevision === selected.lifecycleRevision &&
        current.digest === selected.digest
      );
    },
    release: () => {
      released = true;
    },
  };
}

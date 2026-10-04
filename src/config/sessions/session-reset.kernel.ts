import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  sqliteSessionEntriesEqual,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import type { SessionResetCommit } from "./session-reset.types.js";

/** Durable executor and retained native incognito/maintenance resets share this transaction. */
export function applySessionResetInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionResetCommit,
  projection?: Parameters<typeof appendSessionResetBoundary>[4],
) {
  const snapshot = readLifecycleTargetSnapshot(database, input.target);
  assertLifecycleTargetSnapshotUnchanged(input.prepared, snapshot, "reset");
  const current = snapshot[0];
  const progressCardReset = Boolean(
    input.resetBoundary &&
    current?.entry.sessionId &&
    !sqliteSessionEntriesEqual(current.entry, input.nextEntry) &&
    appendSessionResetBoundary(
      database,
      {
        agentId: input.agentId,
        path: database.path,
        sessionKey: current.sessionKey,
        sessionId: current.entry.sessionId,
      },
      current.entry,
      input.resetBoundary,
      projection,
    ),
  );
  const written = writeSessionEntry(database, input.target.canonicalKey, input.nextEntry, {
    previousEntry: current?.entry ?? null,
  });
  return { current, written, progressCardReset };
}

import { ok, type Result } from "@openclaw/normalization-core/result";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEvent,
  TranscriptEventAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  transcriptWriteScopeIsCurrent,
} from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptEventSnapshotSync } from "./session-accessor.sqlite-transcript-write.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export async function replaceTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      runOpenClawAgentWriteTransaction(
        (database) => {
          replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.replace" },
      );
    },
    "session.transcript.replace",
  );
}

export function replaceTranscriptEventsSync(
  scope: SessionTranscriptWriteScope,
  events: TranscriptEvent[],
): boolean {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const replaced = runOpenClawAgentWriteTransaction(
    (database) => {
      assertOwnedTranscriptWriteCommit(fencedScope);
      const fresh = readSessionEntryRow(database, resolved.sessionKey);
      if (!transcriptWriteScopeIsCurrent(fresh?.entry, resolved.sessionId, fencedScope)) {
        return false;
      }
      replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
      return true;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.transcript.replace" },
  );
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return replaced;
}

export function appendTranscriptEventSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Result<boolean, TranscriptAppendRefusal> {
  const snapshot = appendTranscriptEventSnapshotSync(scope, event, options);
  return snapshot.ok ? ok(snapshot.value.result.appended) : snapshot;
}

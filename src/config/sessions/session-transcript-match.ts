import path from "node:path";
import {
  createVisibleAssistantResultEventMatcher,
  matchesTranscriptEvent,
  type SessionTranscriptEventMatch,
} from "../../sessions/transcript-visible-record.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  findTranscriptEventInDatabase,
  readTranscriptEventId,
} from "./session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readActiveTranscriptEntryAnchorFromProjection,
  readActiveTranscriptEntryAnchorInTransaction,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptProjectionUnavailableError,
} from "./session-transcript-projection-error.js";
import type { SessionTranscriptEventMatchRequest } from "./session-transcript-worker-read.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Select one record inside the caller's existing SQLite snapshot. */
export function findTranscriptEventMatchingInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  request: SessionTranscriptEventMatchRequest,
): { event: TranscriptEvent } | undefined {
  const { target, match } = request;
  const matchesVisibleFinal =
    match.kind === "visible-final"
      ? createVisibleAssistantResultEventMatcher(match.runId)
      : undefined;
  const read = (projection?: CurrentTranscriptProjection) => {
    const matches = (event: TranscriptEvent) => {
      const entryId = readTranscriptEventId(event);
      return (
        (matchesVisibleFinal ? matchesVisibleFinal(event) : matchesTranscriptEvent(event, match)) &&
        ((match.kind !== "active-assistant" && match.kind !== "canvas-widget") ||
          Boolean(
            entryId &&
            target.sessionKey &&
            (projection
              ? readActiveTranscriptEntryAnchorFromProjection(projection, entryId)
              : readActiveTranscriptEntryAnchorInTransaction({
                  database,
                  resolved: { ...target, sessionKey: target.sessionKey },
                  entryId,
                })),
          ))
      );
    };
    return findTranscriptEventInDatabase(
      database,
      target.sessionId,
      matches,
      match.kind === "latest"
        ? undefined
        : (event) => matchesTranscriptEvent(event, match, "navigation"),
    );
  };
  if (match.kind !== "canvas-widget") {
    return read();
  }
  const snapshot = readCurrentProjectionSnapshot(
    { ...database, agentId: target.databaseAgentId ?? target.agentId },
    target,
    read,
  );
  if (snapshot.kind === "unavailable") {
    throw new SessionTranscriptProjectionUnavailableError(target.sessionId);
  }
  return snapshot.value;
}

/** Disk reads and matching belong to the existing read-only history worker. */
export async function findTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: SessionTranscriptEventMatch,
  signal?: AbortSignal,
): Promise<{ event: TranscriptEvent } | undefined> {
  signal?.throwIfAborted();
  const selection = { ...match };
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    const result = memory.missing
      ? undefined
      : (await memory.read("session.history.match", { match: selection })).result;
    memory.assertCurrent();
    return result;
  }
  const captured = {
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const context = captureOpenClawStateWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    signal?.throwIfAborted();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const target = await prepareSqliteTranscriptReadScope(captured);
  assertStateCurrent();
  const options = toDatabaseOptions(target);
  // Retain one physical target through reads, cold restoration and owner revalidation.
  target.path = resolveOpenClawAgentSqlitePath(options);
  return await withSessionHistoryWorkerDatabase(options, async (owner) => {
    const assertCurrent = () => {
      assertStateCurrent();
      owner.assertCurrent();
    };
    try {
      return await readRestoredSessionTranscriptInWorker(
        { scope: captured, resolved: target, owner, assertCurrent },
        () => owner.findTranscriptEvent({ target, match: selection }, signal),
      );
    } catch (error) {
      if (
        selection.kind === "canvas-widget" &&
        isSessionTranscriptProjectionUnavailableError(error)
      ) {
        const { startSessionTranscriptIndexReconcile } =
          await import("./session-transcript-reconcile.js");
        assertCurrent();
        startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: target.sessionId });
      }
      throw error;
    } finally {
      assertCurrent();
    }
  });
}

import path from "node:path";
import type { SessionTranscriptEventMatch } from "../../sessions/transcript-visible-record.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

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

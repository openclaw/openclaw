import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import {
  readSessionTranscriptAnchorsAsync,
  readSessionTranscriptAnchorsFromSource,
} from "./session-transcript-anchor-read.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

export type SessionTranscriptContextProjectionSource = {
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  /** Presence pins a durable source; undefined identity means the captured file was absent. */
  physicalSource?: { expectedIdentity: DatabaseFileIdentity | undefined };
};

export type PreparedSessionTranscriptModelContext = {
  context: SessionTranscriptModelContext;
  writeToken: string;
};

/** Keep a worker's bounded projection attached to its physical source until final acceptance. */
export async function readSessionTranscriptContextProjectionAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  project: (
    source: SessionTranscriptContextProjectionSource,
  ) => Promise<{ value: T; version?: SessionTranscriptContextVersion }>,
  signal?: AbortSignal,
): Promise<T> {
  const captured = { ...target };
  const admission = resolveSessionTranscriptReadFence(captured);
  const capturedAdmission = admission && structuredClone(admission);
  const memory = captureSessionActorTranscriptRead(captured, signal);
  if (memory) {
    const result = await project({ target: memory.target, admission: capturedAdmission });
    memory.assertCurrent();
    return result.value;
  }
  return withSessionTranscriptReadSource(
    captured,
    async (source) => {
      const scope = { ...source.scope, sessionKey: captured.sessionKey };
      const result = await project({
        target: { ...captured, ...scope },
        admission: capturedAdmission,
        physicalSource: { expectedIdentity: source.expectedIdentity },
      });
      source.assertCurrent();
      let accepted = false;
      await readSessionTranscriptAnchorsFromSource(
        { ...source, scope },
        {
          entryIds: [],
          contextValidation: { version: result.version, admission: capturedAdmission },
        },
        signal,
        (facts) => {
          source.assertCurrent();
          accepted = facts.contextValidated === true || (!result.version && !capturedAdmission);
        },
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return result.value;
    },
    signal,
    targetDiscoveryLane,
  );
}

/** Accept consumed results while the original writer FIFO and native witness remain current. */
export function readSessionTranscriptModelContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  consume: (context: SessionTranscriptModelContext) => T,
  admission?: UserTurnTranscriptAdmissionReceipt,
  signal?: AbortSignal,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
  consumeSynchronously = false,
  preparedContext?: PreparedSessionTranscriptModelContext,
): Promise<T> {
  const capturedTarget = { ...target };
  const capturedAdmission = admission ? structuredClone(admission) : undefined;
  const capturedThrough = through ? structuredClone(through) : undefined;
  const capturedLimits = limits ? { ...limits } : undefined;
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    context: SessionTranscriptModelContext,
    assertCurrent: () => void,
    contextAdmission = capturedAdmission,
  ): Promise<T> => {
    const contextValidation = structuredClone({
      version: context.version,
      admission: contextAdmission,
      through: capturedThrough,
    });
    let consumed: { value: Promise<Awaited<T>> } | undefined;
    try {
      await readSessionTranscriptAnchorsAsync(
        scope,
        { entryIds: [], contextValidation },
        signal,
        (facts) => {
          assertCurrent();
          if (
            !facts.contextValidated &&
            (contextValidation.version || contextAdmission || capturedThrough)
          ) {
            throw new SessionTranscriptReadFenceError(
              "Session transcript changed during context read",
            );
          }
          const value = Promise.resolve(consume(context));
          void value.catch(() => undefined);
          consumed = { value };
        },
      );
    } catch (error) {
      // Reader cleanup still joins any write-capable consumer it already started.
      if (consumed) {
        await consumed.value.catch(() => undefined);
      }
      throw error;
    }
    if (!consumed) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
    // The consumer owns its effects. Transcript changes after this snapshot are best effort.
    return await consumed.value;
  };
  const memory = captureSessionActorTranscriptRead(target, signal);
  if (memory) {
    if (memory.missing && (capturedAdmission || capturedThrough)) {
      return Promise.reject(
        new SessionTranscriptReadFenceError("Session transcript is unavailable"),
      );
    }
    const context = memory.missing
      ? Promise.resolve({ events: [] } satisfies SessionTranscriptModelContext)
      : memory.read("session.history.context", {
          ...(capturedAdmission ? { admission: capturedAdmission } : {}),
          through: capturedThrough,
          limits: capturedLimits,
        });
    return context.then(async (value) => {
      memory.assertCurrent();
      const result = consume(value);
      if (consumeSynchronously && isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Prepared model-context consumers must remain synchronous");
      }
      const consumed = await result;
      memory.assertCurrent();
      return consumed;
    });
  }
  return withSessionTranscriptReadSource(
    capturedTarget,
    async ({ scope, expectedIdentity, assertCurrent }) => {
      const captured = { ...scope, sessionKey: capturedTarget.sessionKey };
      const selected =
        consumeSynchronously && capturedLimits && getOwnedSessionTranscriptReader(captured);
      if (selected) {
        const { captureSessionEntryNativeMutationWitness } =
          await import("./session-entry-read-ordered.js");
        assertCurrent();
        const database = selected.database;
        return runOpenClawAgentWriteAdmission(
          database,
          async (_identity, assertOwner) => {
            assertCurrent();
            const assertNative = captureSessionEntryNativeMutationWitness([database]);
            const context =
              preparedContext &&
              !capturedAdmission &&
              !capturedThrough &&
              preparedContext.writeToken === readSqliteDatabaseWriteTokenForPath(database.path)
                ? preparedContext.context
                : await readSessionTranscriptModelContextInWorker(
                    captured,
                    capturedAdmission,
                    signal,
                    capturedThrough,
                    capturedLimits,
                    expectedIdentity,
                  );
            signal?.throwIfAborted();
            assertOwner();
            assertCurrent();
            assertNative();
            const value = consume(context);
            if (isPromiseLike(value)) {
              void Promise.resolve(value).catch(() => {});
              throw new Error("Prepared model-context consumers must remain synchronous");
            }
            assertOwner();
            assertCurrent();
            assertNative();
            return value;
          },
          true,
          undefined,
          signal,
        );
      }
      const context = await readSessionTranscriptModelContextInWorker(
        captured,
        capturedAdmission,
        signal,
        capturedThrough,
        capturedLimits,
        expectedIdentity,
      );
      assertCurrent();
      return accept(captured, context, assertCurrent, capturedAdmission);
    },
    signal,
  );
}

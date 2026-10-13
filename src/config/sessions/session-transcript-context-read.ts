import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import {
  readSessionTranscriptAnchorsAsync,
  readSessionTranscriptAnchorsFromSource,
} from "./session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  resolveSessionTranscriptReadFence,
  withSessionContextAdmission,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import {
  withSessionTranscriptReadSource,
  type SessionTranscriptWorkerReadSource,
} from "./session-transcript-read-source.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import {
  sameTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "./transcript-entry-anchor.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

export type SessionTranscriptContextProjectionSource = {
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  /** Presence pins a durable source; undefined identity means the captured file was absent. */
  physicalSource?: { expectedIdentity: DatabaseFileIdentity | undefined };
};

function assertCurrentInputAnchor(
  admission: UserTurnTranscriptAdmissionReceipt,
  current: TranscriptEntryAnchor | undefined,
): void {
  // The retained reader may use an alias of the admission owner's physical store.
  const admittedCurrent =
    current &&
    current.storePath !== admission.storePath &&
    isSameOpenClawAgentDatabasePath(admission.storePath, current.storePath)
      ? { ...current, storePath: admission.storePath }
      : current;
  if (!sameTranscriptEntryAnchor(admission, admittedCurrent)) {
    throw new SessionTranscriptReadFenceError("Current-turn transcript admission changed");
  }
}

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
  return withSessionTranscriptReadSource(
    captured,
    async (scope) => {
      const result = await project({
        target: { ...captured, ...scope },
        admission: capturedAdmission,
      });
      let accepted = false;
      await readSessionTranscriptAnchorsAsync(
        { ...scope, sessionKey: captured.sessionKey },
        {
          entryIds: [],
          contextValidation: { version: result.version, admission: capturedAdmission },
        },
        signal,
        (facts) => {
          accepted = facts.contextValidated === true || (!result.version && !capturedAdmission);
        },
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return result.value;
    },
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
          entryIds: capturedAdmission ? [capturedAdmission.entryId] : [],
          contextValidation: { version: result.version, admission: capturedAdmission },
        },
        signal,
        (facts) => {
          source.assertCurrent();
          if (capturedAdmission) {
            assertCurrentInputAnchor(capturedAdmission, facts.anchors[0]);
          }
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
  suppliedIncognito?: IncognitoSessionHistoryBinding,
  consumeSynchronously = false,
): Promise<T> {
  const capturedTarget = { ...target };
  const capturedAdmission = admission ? structuredClone(admission) : undefined;
  const capturedThrough = through ? structuredClone(through) : undefined;
  const capturedLimits = limits ? { ...limits } : undefined;
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    context: SessionTranscriptModelContext,
    assertCurrent: () => void,
    binding?: IncognitoSessionHistoryBinding,
    contextAdmission = capturedAdmission,
    source?: SessionTranscriptWorkerReadSource,
  ): Promise<T> => {
    const contextValidation = structuredClone({
      version: context.version,
      admission: contextAdmission,
      through: capturedThrough,
    });
    const admissionAnchor = source ? contextAdmission : undefined;
    const sharesThroughAnchor =
      admissionAnchor && capturedThrough?.entryId === admissionAnchor.entryId;
    if (sharesThroughAnchor) {
      assertCurrentInputAnchor(admissionAnchor, capturedThrough);
    }
    const selection = {
      entryIds: admissionAnchor && !sharesThroughAnchor ? [admissionAnchor.entryId] : [],
      contextValidation,
    };
    let consumed: { value: Promise<Awaited<T>> } | undefined;
    try {
      const onRead = (facts: SessionTranscriptAnchorFacts) => {
        assertCurrent();
        if (
          !facts.contextValidated &&
          (contextValidation.version || contextAdmission || capturedThrough)
        ) {
          throw new SessionTranscriptReadFenceError(
            "Session transcript changed during context read",
          );
        }
        if (admissionAnchor && !sharesThroughAnchor) {
          assertCurrentInputAnchor(
            admissionAnchor,
            facts.anchors.find((anchor) => anchor.entryId === admissionAnchor.entryId),
          );
        }
        const value = Promise.resolve(consume(context));
        void value.catch(() => undefined);
        consumed = { value };
      };
      if (source) {
        await readSessionTranscriptAnchorsFromSource(
          { ...source, scope: { ...source.scope, sessionKey: scope.sessionKey } },
          selection,
          signal,
          onRead,
        );
      } else {
        await readSessionTranscriptAnchorsAsync(scope, selection, signal, onRead, binding);
      }
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
  const source = suppliedIncognito ? undefined : captureIncognitoSessionSource(target);
  if (source && "kind" in source) {
    signal?.throwIfAborted();
    if (capturedAdmission || capturedThrough) {
      return Promise.reject(
        new SessionTranscriptReadFenceError("Session transcript is unavailable"),
      );
    }
    return Promise.resolve(consume({ events: [] })).then((result) => {
      signal?.throwIfAborted();
      source.assertCurrent();
      return result;
    });
  }
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(target);
  if (incognito) {
    const prepared = prepareIncognitoSessionHistoryRead(incognito, target, signal);
    const contextAdmission = capturedAdmission ?? prepared.target.admission;
    return prepared.actor.sessions
      .withSharedState(async () => {
        const context = await prepared.actor.sessions.history(
          prepared.authority,
          {
            type: "session.history.context",
            input: {
              ...prepared.target,
              admission: contextAdmission,
              through: capturedThrough,
              limits: capturedLimits,
            },
          },
          signal,
        );
        return accept(
          capturedTarget,
          context,
          prepared.authority.assertCurrent,
          prepared,
          contextAdmission,
        );
      })
      .then((result) => {
        prepared.authority.assertCurrent();
        if (prepared.actor.sessions.readSharing(prepared.target.sessionKey)?.entry) {
          prepared.actor.sessions
            .captureCurrent(prepared.target.sessionKey)
            .authorize(prepared.authority, "commit");
        }
        return result;
      });
  }
  return withSessionTranscriptReadSource(
    capturedTarget,
    async (scope) => {
      // Capture incognito synchronously, then revalidate after the public async boundary.
      const context = await Promise.resolve(
        withSessionContextAdmission(capturedTarget, capturedAdmission, () =>
          readSessionTranscriptModelContext(scope, capturedThrough, capturedLimits),
        ),
      );
      return accept(capturedTarget, context, () => signal?.throwIfAborted());
    },
    async (readSource) => {
      const { scope, expectedIdentity, assertCurrent } = readSource;
      const captured = { ...scope, sessionKey: capturedTarget.sessionKey };
      const selected =
        !capturedAdmission &&
        consumeSynchronously &&
        capturedLimits &&
        getOwnedSessionTranscriptReader(captured);
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
            const context = await readSessionTranscriptModelContextInWorker(
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
          "history.model-context",
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
      return accept(
        captured,
        context,
        assertCurrent,
        undefined,
        capturedAdmission,
        capturedAdmission || capturedThrough ? readSource : undefined,
      );
    },
    signal,
    undefined,
    capturedThrough?.storePath,
  );
}

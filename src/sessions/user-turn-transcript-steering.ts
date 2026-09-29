import { isDeepStrictEqual } from "node:util";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.sqlite-events.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  type SessionTranscriptWriterFence,
} from "../config/sessions/transcript-write-context.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import { confirmSteeredUserTurnTranscript } from "./user-turn-transcript-steering-store.js";
import type {
  SteeredUserTurnTranscriptCommit,
  SteeredUserTurnTranscriptSnapshot,
} from "./user-turn-transcript-steering.types.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

type AdmissionOwner = NonNullable<ReturnType<typeof getUserTurnTranscriptAdmissionOwner>>;
export type CaptureSteeredUserTurnConfirmation = (
  source: UserTurnTranscriptRecorder,
  assertSource: () => void,
) => () => Promise<void>;

function snapshot(owner: AdmissionOwner): SteeredUserTurnTranscriptSnapshot {
  const admission = owner.receipt();
  const message = owner.message();
  if (!admission || !message || owner.blocked()) {
    throw new Error("Steer confirmation requires its private persisted admission");
  }
  return structuredClone({ admission, message });
}

async function confirm(params: {
  source: AdmissionOwner;
  continuation?: AdmissionOwner;
  targetRunId: string;
  target?: SessionTranscriptRuntimeTarget & SessionTranscriptWriterFence;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const { source, continuation } = params;
  params.assertCurrent();
  await source.waitForPersistence();
  params.assertCurrent();
  const sourceSnapshot = snapshot(source);
  // The previous confirmation installed A before this serialized operation started.
  // Never rediscover a generation from storage, or renew a rejected receipt.
  const continuationSnapshot = continuation ? snapshot(continuation) : undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    if (
      !isDeepStrictEqual(snapshot(source), sourceSnapshot) ||
      (continuation && !isDeepStrictEqual(snapshot(continuation), continuationSnapshot))
    ) {
      throw new Error("Steer confirmation lost its private admission owner");
    }
  };
  let result: SteeredUserTurnTranscriptCommit | undefined;
  try {
    await confirmSteeredUserTurnTranscript({
      source: sourceSnapshot,
      continuation: continuationSnapshot,
      targetRunId: params.targetRunId,
      target: params.target,
      signal: params.signal,
      assertCurrent,
      onCommitted: (committed) => {
        // Both receipts become visible synchronously inside the retained writer FIFO.
        if (continuation && continuationSnapshot) {
          continuation.refresh(
            { ...continuationSnapshot.admission, generation: committed.generation },
            continuationSnapshot.message,
          );
        }
        source.refresh(
          { ...sourceSnapshot.admission, generation: committed.generation },
          committed.message,
        );
        source.confirmSteerTarget(params.targetRunId);
        result = committed;
      },
    });
  } catch (error) {
    if (!result) {
      throw error;
    }
    source.reportPublicationError(error);
  }
  if (result?.changed) {
    try {
      await publishTranscriptUpdate(sourceSnapshot.admission, {
        message: result.message,
        messageId: sourceSnapshot.admission.entryId,
        messageSeq: sourceSnapshot.admission.activeMessagePosition + 1,
      });
    } catch (error) {
      // Publication cannot make committed input replayable. Producer failures above
      // still reject; only this post-commit notification is best effort.
      source.reportPublicationError(error);
    }
  }
}

/** Host-only: capture the exact factory owner, never a public recorder copy or run-id lookup. */
export function bindSteeredUserTurnConfirmation(params: {
  recorder: UserTurnTranscriptRecorder | undefined;
  targetRunId: string;
  target?: SessionTranscriptRuntimeTarget & Partial<SessionTranscriptWriterFence>;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): CaptureSteeredUserTurnConfirmation {
  const continuation = params.recorder && getUserTurnTranscriptAdmissionOwner(params.recorder);
  if (params.recorder && !continuation) {
    return () => async () => {
      throw new Error("Steer confirmation requires a factory-owned continuation");
    };
  }
  const scope = params.target ?? continuation?.receipt();
  const assertWriter = scope ? captureOwnedTranscriptWriteAssertion(scope) : () => undefined;
  const fence = scope ? getOwnedSessionTranscriptWriterFence({ sessionTarget: scope }) : undefined;
  const expectedWriterRunId = params.target?.expectedWriterRunId ?? fence?.expectedWriterRunId;
  const target =
    scope && expectedWriterRunId
      ? {
          ...scope,
          expectedLifecycleRevision:
            params.target?.expectedLifecycleRevision ?? fence?.expectedLifecycleRevision,
          expectedWriterRunId,
        }
      : undefined;
  let ordered = Promise.resolve();
  return (recorder, assertSource) => {
    const source = getUserTurnTranscriptAdmissionOwner(recorder);
    // Authority follows the caller-facing target, which may be a sessions.json
    // alias. The worker independently verifies both physical receipt snapshots.
    const sourceScope = scope ?? source?.receipt();
    const assertSourceWriter = sourceScope
      ? captureOwnedTranscriptWriteAssertion(sourceScope)
      : () => undefined;
    let revoked: Error | undefined;
    const assertCurrent = () => {
      if (revoked) {
        throw revoked;
      }
      try {
        params.signal?.throwIfAborted();
        params.assertCurrent();
        assertSource();
        assertWriter();
        assertSourceWriter();
        if (!source || source === continuation) {
          throw new Error("Steer confirmation requires a distinct factory-owned input");
        }
      } catch (error) {
        revoked = toErrorObject(error, "Steer confirmation authority was revoked");
        throw revoked;
      }
    };
    let pending: Promise<void> | undefined;
    return () => {
      // Each resolved injection confirms at most once, including after rejection.
      pending ??= ordered.then(async () => {
        assertCurrent();
        if (!source) {
          throw new Error("Steer confirmation requires a factory-owned input");
        }
        await confirm({ ...params, target, source, continuation, assertCurrent });
      });
      ordered = pending.catch(() => undefined);
      return pending;
    };
  };
}

/** Public recorder compatibility uses the same exact writer, without inventing continuation authority. */
export async function confirmRecorderSteerTarget(
  recorder: UserTurnTranscriptRecorder,
  targetRunId: string,
): Promise<void> {
  const source = getUserTurnTranscriptAdmissionOwner(recorder);
  if (!source) {
    throw new Error("Steer confirmation requires a factory-owned input");
  }
  await confirm({ source, targetRunId, assertCurrent: () => undefined });
}

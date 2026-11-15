import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import {
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  resolveSessionTranscriptDatabasePath,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../config/sessions/session-entry-current-check.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { sessionMatchesExpectedTranscriptTurn } from "../config/sessions/session-transcript-turn-state.js";
import { snapshotTranscriptTurnAdmission } from "../config/sessions/transcript-entry-anchor.js";
import { getOwnedSessionTranscriptWriterFence } from "../config/sessions/transcript-write-context.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db.paths.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import { prepareUserTurnTranscriptAnnotation } from "./user-turn-transcript-annotation-message.js";
import type {
  UserTurnTranscriptAnnotation,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

/** Core-only binding performed by the harness host before invoking plugin code. */
export function bindUserTurnTranscriptAnnotation(params: {
  recorder: UserTurnTranscriptRecorder;
  target: SessionTranscriptRuntimeTarget & {
    expectedLifecycleRevision?: string;
    expectedWriterRunId?: string;
  };
  runId: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
}): ((annotation: UserTurnTranscriptAnnotation) => Promise<void>) | undefined {
  const owner = getUserTurnTranscriptAdmissionOwner(params.recorder);
  const receipt = owner?.receipt();
  const message = owner?.message();
  if (!owner || !receipt || !message || owner.blocked() || message.excludeFromContext === true) {
    return undefined;
  }
  let admission = snapshotTranscriptTurnAdmission(receipt);
  let admittedMessage = structuredClone(message);
  const target = { ...params.target };
  const fence = getOwnedSessionTranscriptWriterFence({ sessionTarget: target });
  if (
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey ||
    target.agentId !== admission.agentId ||
    !isSameOpenClawAgentDatabasePath(
      resolveSessionTranscriptDatabasePath(target),
      admission.storePath,
    )
  ) {
    return undefined;
  }
  const assertLive = () => {
    params.assertCurrent();
    if (
      params.abortSignal?.aborted ||
      owner.blocked() ||
      !isDeepStrictEqual(owner.receipt(), admission) ||
      !isDeepStrictEqual(owner.message(), admittedMessage) ||
      admittedMessage["__openclaw"]?.steerTargetRunId !== undefined
    ) {
      throw new Error("current user admission is no longer available for native annotation");
    }
  };
  return async (annotation) => {
    // Copy only the closed provenance tuple before any await; the host fixes the run ID.
    const capturedAnnotation = {
      mirrorIdentity: annotation.mirrorIdentity,
      upstreamUserText: annotation.upstreamUserText,
      mirrorOrigin: annotation.mirrorOrigin,
      mirrorSourceFingerprint: annotation.mirrorSourceFingerprint,
    };
    assertLive();
    // The admission owns an exact key; cron base and run rows can share a session ID.
    const entryAuthority = await captureSessionEntryCurrentCheckAsyncInternal({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      fields: ["sessionId", "lifecycleRevision", "activeWriterRunId"],
      errorMessage: "current user admission is no longer available for native annotation",
    });
    try {
      const selected = entryAuthority.entry;
      if (
        !selected ||
        selected.sessionId !== admission.sessionId ||
        (selected.activeWriterRunId !== undefined && selected.activeWriterRunId !== params.runId)
      ) {
        throw new Error("current user admission is no longer available for native annotation");
      }
      const expectedLifecycleRevision =
        target.expectedLifecycleRevision ??
        fence?.expectedLifecycleRevision ??
        selected.lifecycleRevision ??
        null;
      const expectedWriterRunId = target.expectedWriterRunId ?? fence?.expectedWriterRunId;
      if (
        !sessionMatchesExpectedTranscriptTurn(
          { entry: selected },
          {
            expectedSessionId: admission.sessionId,
            expectedLifecycleRevision,
            expectedWriterRunId,
          },
        ) ||
        (fence?.expectedWriterRunId !== undefined &&
          selected.activeWriterRunId !== fence.expectedWriterRunId) ||
        (fence?.expectedLifecycleRevision !== undefined &&
          selected.lifecycleRevision !== fence.expectedLifecycleRevision)
      ) {
        throw new Error("current user admission is no longer available for native annotation");
      }
      const assertNativeCurrent = () => {
        assertLive();
        entryAuthority.source();
        const { logicalTurnId: _logicalTurnId, role: _role, ...anchor } = admission;
        if (!isDeepStrictEqual(readActiveTranscriptEntryAnchor(admission), anchor)) {
          throw new Error("current user admission is no longer available for native annotation");
        }
      };
      let verified = false;
      const { logicalTurnId: _logicalTurnId, role: _role, ...anchor } = admission;
      const rewritten = await rewritePreparedTranscriptMessageAtAnchor(
        anchor,
        (current) => {
          assertLive();
          if (!isDeepStrictEqual(current, admittedMessage)) {
            throw new Error("native prompt annotation cannot replace an edited admission");
          }
          const annotatedMessage = prepareUserTurnTranscriptAnnotation(
            admittedMessage,
            capturedAnnotation,
            params.runId,
          );
          verified = true;
          return isDeepStrictEqual(annotatedMessage, admittedMessage)
            ? undefined
            : annotatedMessage;
        },
        {
          active: "exact",
          expectedEntry: {
            lifecycleRevision: expectedLifecycleRevision,
            activeWriterRunId: expectedWriterRunId ?? selected.activeWriterRunId ?? null,
          },
          assertCurrent: assertLive,
          assertNativeCurrent,
        },
      );
      if (!verified) {
        throw new Error("native prompt admission disappeared before annotation");
      }
      if (rewritten) {
        admission = { ...admission, generation: rewritten.generation };
        // Recorder getters and update listeners must never expose the private validation snapshot.
        admittedMessage = structuredClone(rewritten.message);
        owner.refresh({ ...admission }, rewritten.message);
        await waitForSessionTranscriptProjection(admission, params.abortSignal);
      }
      assertLive();
      if (rewritten) {
        await publishTranscriptUpdate(admission, {
          message: rewritten.message,
          messageId: admission.entryId,
          messageSeq: admission.activeMessagePosition + 1,
        });
        assertLive();
      }
    } finally {
      entryAuthority.release();
    }
  };
}

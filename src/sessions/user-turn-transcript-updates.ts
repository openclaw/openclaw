import { redactTranscriptText } from "../agents/transcript-redact-text.js";
import {
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  rewriteTranscriptMessageAtAnchor,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isUserMessage, readModelPromptProjection } from "./user-turn-transcript.message.js";
import {
  normalizePersistedSteerTargetRunId,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
} from "./user-turn-transcript.types.js";

export async function confirmPersistedSteerTargetRunId(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  targetRunId: string;
}): Promise<
  | {
      admission: UserTurnTranscriptAdmissionReceipt;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const rewritten = await rewriteTranscriptMessageAtAnchor(params.admission, (message) => {
    if (!isUserMessage(message)) {
      return undefined;
    }
    const currentTarget = normalizePersistedSteerTargetRunId(
      message["__openclaw"]?.steerTargetRunId,
    );
    return currentTarget === params.targetRunId
      ? undefined
      : rewritePersistedSteerTargetRunId(message, params.targetRunId);
  });
  if (!rewritten) {
    return undefined;
  }
  const admission = { ...params.admission, generation: rewritten.generation };
  await publishTranscriptUpdate(admission, {
    message: rewritten.message,
    messageId: admission.entryId,
    messageSeq: admission.activeMessagePosition + 1,
  });
  return { admission, message: rewritten.message };
}

export async function capturePersistedModelPromptProjection(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  message: PersistedUserTurnMessage;
  text: string;
  requestLocal?: boolean;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  assertWritable: () => void;
  onCommitted: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
}): Promise<PersistedUserTurnMessage> {
  params.assertCurrent();
  const text = redactTranscriptText(params.text, params.config);
  const projected = (candidate: PersistedUserTurnMessage): PersistedUserTurnMessage => ({
    ...candidate,
    __openclaw: { ...candidate["__openclaw"], modelPromptProjection: { version: 1, text } },
  });
  // Request-local text crosses the provider boundary under the same redaction, never durably.
  if (params.requestLocal) {
    return projected(params.message);
  }
  const requireMatchingProjection = (candidate: PersistedUserTurnMessage) => {
    const existing = readModelPromptProjection(candidate);
    if (existing !== undefined && existing !== text) {
      throw new Error("A captured user-turn model prompt projection cannot be changed");
    }
    return existing !== undefined;
  };
  if (requireMatchingProjection(params.message)) {
    return params.message;
  }
  params.assertWritable();
  let captured: PersistedUserTurnMessage | undefined;
  const rewritten = await rewriteTranscriptMessageAtAnchor(params.admission, (candidate) => {
    params.assertWritable();
    // Only the still-active admitted row may gain a projection; a moved branch keeps its bytes.
    if (readActiveTranscriptEntryAnchor(params.admission)?.rawSeq !== params.admission.rawSeq) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    if (!isUserMessage(candidate)) {
      throw new Error("Model prompt projection lost its canonical user turn");
    }
    if (requireMatchingProjection(candidate)) {
      captured = candidate;
      return undefined;
    }
    return projected(candidate);
  });
  params.assertCurrent();
  if (!rewritten) {
    if (!captured) {
      // The anchored row was replaced before the rewrite; never attach to its successor.
      throw new SessionTranscriptWriterClaimReboundError();
    }
    params.onCommitted(params.admission, captured);
    return captured;
  }
  const admission = { ...params.admission, generation: rewritten.generation };
  params.onCommitted(admission, rewritten.message);
  await publishTranscriptUpdate(admission, {
    message: rewritten.message,
    messageId: admission.entryId,
    messageSeq: admission.activeMessagePosition + 1,
  });
  params.assertCurrent();
  return rewritten.message;
}

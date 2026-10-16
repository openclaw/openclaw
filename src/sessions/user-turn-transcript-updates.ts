import { publishTranscriptUpdate } from "../config/sessions/session-accessor.sqlite-events.js";
import {
  capturePreparedTranscriptModelPromptProjection,
  rewritePreparedTranscriptMessageAtAnchor,
} from "../config/sessions/session-message-rewrite.js";
import {
  isUserMessage,
  prepareModelPromptProjection,
  readModelPromptProjection,
} from "./user-turn-transcript.message.js";
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
  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(params.admission, (message) => {
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
  assertCurrent: () => void;
  assertWritable: () => void;
  onCommitted: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
}): Promise<PersistedUserTurnMessage> {
  params.assertCurrent();
  if (readModelPromptProjection(params.message) !== undefined) {
    prepareModelPromptProjection(params.message, params.text);
    return params.message;
  }
  params.assertWritable();
  const rewritten = await capturePreparedTranscriptModelPromptProjection(
    params.admission,
    params.text,
    params.assertWritable,
  );
  params.assertCurrent();
  if (!rewritten) {
    throw new Error("Model prompt projection lost its canonical user turn");
  }
  if (rewritten.unchanged) {
    params.onCommitted(params.admission, rewritten.message);
    return rewritten.message;
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

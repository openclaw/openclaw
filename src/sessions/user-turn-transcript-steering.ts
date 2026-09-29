import { isDeepStrictEqual } from "node:util";
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.sqlite-events.js";
import { confirmSessionTranscriptSteering } from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export async function confirmPersistedSteerTargetRunId(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  targetRunId: string;
  foregroundRecorder?: UserTurnTranscriptRecorder;
}): Promise<
  | {
      admission: UserTurnTranscriptAdmissionReceipt;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const foregroundOwner = params.foregroundRecorder
    ? getUserTurnTranscriptAdmissionOwner(params.foregroundRecorder)
    : undefined;
  let retainedAdmission: UserTurnTranscriptAdmissionReceipt | undefined;
  let retainedMessage: PersistedUserTurnMessage | undefined;
  const confirmed = await confirmSessionTranscriptSteering({
    admission: params.admission,
    targetRunId: params.targetRunId,
    prepareForegroundAdmission: () => {
      // The writer FIFO owns this capture so overlapping accepted steers observe
      // the previous confirmation's already-published foreground receipt.
      const receipt = foregroundOwner?.receipt();
      const message = foregroundOwner?.message();
      if (!receipt || !message || foregroundOwner?.blocked()) {
        return undefined;
      }
      retainedAdmission = structuredClone(receipt);
      retainedMessage = structuredClone(message);
      return retainedAdmission;
    },
    onConfirmed: (result) => {
      if (
        result.foregroundAdmission &&
        foregroundOwner &&
        retainedAdmission &&
        retainedMessage &&
        !foregroundOwner.blocked() &&
        isDeepStrictEqual(foregroundOwner.receipt(), retainedAdmission) &&
        isDeepStrictEqual(foregroundOwner.message(), retainedMessage)
      ) {
        foregroundOwner.refresh(result.foregroundAdmission, retainedMessage);
      }
    },
  });
  if (!confirmed) {
    return undefined;
  }
  await publishTranscriptUpdate(confirmed.admission, {
    message: confirmed.message,
    messageId: confirmed.admission.entryId,
    messageSeq: confirmed.admission.activeMessagePosition + 1,
  });
  return confirmed;
}

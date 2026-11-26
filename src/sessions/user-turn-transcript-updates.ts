import { publishTranscriptUpdate } from "../config/sessions/session-accessor.sqlite-events.js";
import {
  capturePreparedTranscriptModelPromptProjection,
  rewritePreparedTranscriptMessageAtAnchor,
} from "../config/sessions/session-message-rewrite.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import type { PersistedUserTurnMessage } from "./user-turn-input.types.js";
import {
  isUserMessage,
  prepareModelPromptProjection,
  readModelPromptProjection,
} from "./user-turn-transcript.message.js";
import { normalizePersistedSteerTargetRunId } from "./user-turn-transcript.metadata.js";
import type {
  NativeSteerInputIdentity,
  PreparedModelPromptProjection,
  UserTurnTranscriptAdmissionReceipt,
} from "./user-turn-transcript.types.js";

export async function confirmPersistedSteerTargetRunId(
  receipt: UserTurnTranscriptAdmissionReceipt,
  targetRunId: string,
  nativeInputIdentity?: NativeSteerInputIdentity,
): Promise<
  | {
      admission: UserTurnTranscriptAdmissionReceipt;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(receipt, (message) => {
    if (!isUserMessage(message)) {
      return undefined;
    }
    const existing = message["__openclaw"];
    let changed = normalizePersistedSteerTargetRunId(existing?.steerTargetRunId) !== targetRunId;
    for (const [key, value] of Object.entries(nativeInputIdentity ?? {})) {
      if (existing?.[key] === value) {
        continue;
      }
      if (existing?.[key] !== undefined) {
        throw new Error(
          "Accepted native input identity conflicts with the committed transcript row.",
        );
      }
      changed = true;
    }
    return changed
      ? {
          ...message,
          __openclaw: { ...existing, steerTargetRunId: targetRunId, ...nativeInputIdentity },
        }
      : undefined;
  });
  if (!rewritten) {
    return undefined;
  }
  const admission = { ...receipt, generation: rewritten.generation };
  await publishTranscriptUpdate(admission, {
    message: rewritten.message,
    messageId: admission.entryId,
    messageSeq: admission.activeMessagePosition + 1,
  });
  return { admission, message: rewritten.message };
}

type AudioApiKeyFailure = { reference: string; provider: string };

async function annotateAudioApiKeyFailures(
  admission: UserTurnTranscriptAdmissionReceipt,
  failures: readonly AudioApiKeyFailure[],
) {
  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(admission, (message) => {
    if (!isUserMessage(message) || message["__openclaw"]?.audioApiKeyRequired) {
      return undefined;
    }
    const media = readPersistedMediaFacts(message);
    const failure = failures.find(({ reference }) =>
      media?.some(
        (fact) => !fact.transcribed && (fact.url === reference || fact.path === reference),
      ),
    );
    return failure
      ? {
          ...message,
          __openclaw: { ...message["__openclaw"], audioApiKeyRequired: failure.provider },
        }
      : undefined;
  });
  if (!rewritten) {
    return undefined;
  }
  const next = { ...admission, generation: rewritten.generation };
  await publishTranscriptUpdate(next, {
    message: rewritten.message,
    messageId: next.entryId,
    messageSeq: next.activeMessagePosition + 1,
  });
  return { admission: next, message: rewritten.message };
}

export function createAudioApiKeyFailureCapture(params: {
  admission: () => UserTurnTranscriptAdmissionReceipt | undefined;
  admitting: () => Promise<void> | undefined;
  onCommitted: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
  onError: (error: unknown) => void;
}) {
  let pending: readonly AudioApiKeyFailure[] | undefined;
  const stamp = async () => {
    const admission = params.admission();
    if (!admission || !pending) {
      return;
    }
    const failures = pending;
    pending = undefined;
    await annotateAudioApiKeyFailures(admission, failures).then(
      (annotated) => annotated && params.onCommitted(annotated.admission, annotated.message),
      params.onError,
    );
  };
  return {
    afterAdmission: async (published: void | Promise<void>) => {
      await published;
      await stamp();
    },
    record: async (failures: readonly AudioApiKeyFailure[]) => {
      if (failures.length > 0) {
        pending = failures;
        await params.admitting();
        await stamp();
      }
    },
  };
}

type ModelPromptProjectionParams = {
  admission: UserTurnTranscriptAdmissionReceipt;
  message: PersistedUserTurnMessage;
  text: string;
  assertCurrent: () => void;
  assertWritable: () => void;
  onCommitted: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
};

export function preparePersistedModelPromptProjection(
  params: ModelPromptProjectionParams,
): PreparedModelPromptProjection | undefined {
  if (readModelPromptProjection(params.message) !== undefined) {
    prepareModelPromptProjection(params.message, params.text);
    return undefined;
  }
  params.assertWritable();
  return {
    intent: { anchor: params.admission, text: params.text },
    async onCommitted(rewritten) {
      if (!rewritten || !isUserMessage(rewritten.message)) {
        throw new Error("Model prompt projection lost its canonical user turn");
      }
      const admission = { ...params.admission, generation: rewritten.generation };
      params.onCommitted(admission, rewritten.message);
      if (!rewritten.unchanged) {
        await publishTranscriptUpdate(admission, {
          message: rewritten.message,
          messageId: admission.entryId,
          messageSeq: admission.activeMessagePosition + 1,
        });
      }
      return rewritten.message;
    },
  };
}

export async function capturePersistedModelPromptProjection(
  params: ModelPromptProjectionParams,
): Promise<PersistedUserTurnMessage> {
  const prepared = preparePersistedModelPromptProjection(params);
  if (!prepared) {
    return params.message;
  }
  const rewritten = await capturePreparedTranscriptModelPromptProjection(
    prepared.intent.anchor,
    prepared.intent.text,
    params.assertWritable,
  );
  const message = await prepared.onCommitted(rewritten);
  params.assertCurrent();
  return message;
}

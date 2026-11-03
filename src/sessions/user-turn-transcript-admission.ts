import type { RequesterOrigin } from "../agents/requester-origin.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import type { SessionReactionWrite } from "../config/sessions/session-reaction-store.types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export type CurrentPromptReaction = (params: {
  emoji: string;
  remove: boolean;
  dryRun: boolean;
  assertCurrent: () => void;
}) => Promise<Pick<SessionReactionWrite, "changed" | "reactions"> & { messageId: string }>;

/** Original authenticated source custody, independent of the run that consumes it. */
export type UserTurnPromptReactionSource = Readonly<{
  agentId: string;
  sessionKey: string;
  prepare?: () => Promise<void>;
  assertCurrent: () => void;
  createReaction: (recorder: UserTurnTranscriptRecorder) => CurrentPromptReaction;
}>;

type AdmissionOwner = {
  requesterOrigin: () => RequesterOrigin | undefined;
  promptReactionSource?: UserTurnPromptReactionSource;
  pendingInput: () => SessionPendingInputReceipt | undefined;
  withdrawnInputId: () => string | undefined;
  receipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  message: () => PersistedUserTurnMessage | undefined;
  submittedText?: string;
  captureSubmittedText: (message: PersistedUserTurnMessage | undefined) => void;
  invalidateSubmittedText: () => void;
  blocked: () => boolean;
  sentToProvider: () => boolean;
  refresh: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
};

// Only the recorder factory registers an owner; copied SDK values cannot bind one.
const admissionOwners = new WeakMap<UserTurnTranscriptRecorder, AdmissionOwner>();

export function registerUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
  owner: Omit<AdmissionOwner, "captureSubmittedText" | "invalidateSubmittedText">,
): AdmissionOwner {
  const registered = Object.assign(owner, {
    captureSubmittedText(message: PersistedUserTurnMessage | undefined) {
      if (!message || owner.pendingInput() || owner.receipt()) {
        return;
      }
      // Hooks can mutate content in place. Capture before adoption; late media
      // cannot supply or change the original input's comparison text.
      owner.submittedText ??=
        extractTextFromChatContent(message.content, {
          joinWith: "\n",
          normalizeText: (value) => value,
        }) ?? "";
    },
    invalidateSubmittedText() {
      delete owner.submittedText;
    },
  });
  admissionOwners.set(recorder, registered);
  return registered;
}

export function getUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
): AdmissionOwner | undefined {
  return admissionOwners.get(recorder);
}

/** Preserve prepared producer facts; accepted input takes precedence after durable custody. */
export function readUserTurnRequesterOrigin(recorder: UserTurnTranscriptRecorder | undefined) {
  const owner = recorder && admissionOwners.get(recorder);
  return owner?.requesterOrigin();
}

export function bindUserTurnPromptReactionSource(
  recorder: UserTurnTranscriptRecorder,
  source: UserTurnPromptReactionSource,
): void {
  const owner = admissionOwners.get(recorder);
  if (!owner) {
    throw new Error("Prompt reaction source requires its native recorder owner");
  }
  owner.promptReactionSource = source;
}

export function readUserTurnPromptReactionSource(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnPromptReactionSource | undefined {
  return recorder ? admissionOwners.get(recorder)?.promptReactionSource : undefined;
}

/** Collection carries only same-session authenticated custody, never runner defaults. */
export function inheritUserTurnPromptReactionSource(
  recorder: UserTurnTranscriptRecorder,
  sources: readonly UserTurnTranscriptRecorder[] | undefined,
): void {
  if (!sources?.length) {
    return;
  }
  const inherited: UserTurnPromptReactionSource[] = [];
  for (const sourceRecorder of sources) {
    const source = readUserTurnPromptReactionSource(sourceRecorder);
    if (!source) {
      return;
    }
    inherited.push(source);
  }
  const latest = inherited.at(-1);
  if (
    !latest ||
    inherited.some(
      (source) => source.agentId !== latest.agentId || source.sessionKey !== latest.sessionKey,
    )
  ) {
    return;
  }
  bindUserTurnPromptReactionSource(recorder, {
    ...latest,
    prepare: async () => {
      await Promise.all(inherited.flatMap((source) => (source.prepare ? [source.prepare()] : [])));
    },
    assertCurrent: () => inherited.forEach((source) => source.assertCurrent()),
  });
}

export function readWithdrawnUserTurnInputId(
  recorder: UserTurnTranscriptRecorder | undefined,
): string | undefined {
  return recorder && admissionOwners.get(recorder)?.withdrawnInputId();
}

/** Snapshot only the factory-owned input that has not crossed its foreground model boundary. */
export function readPendingUserTurnTranscriptAdmission(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnTranscriptAdmissionReceipt | undefined {
  const owner = recorder ? admissionOwners.get(recorder) : undefined;
  if (!owner || owner.blocked() || owner.sentToProvider()) {
    return undefined;
  }
  const receipt = owner.receipt();
  return receipt ? { ...receipt } : undefined;
}

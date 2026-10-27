import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { createMessageInjectionAuthority } from "../auto-reply/reply/message-injection-authority.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import type { SessionReactionWrite } from "../config/sessions/session-reaction-store.types.js";
import type {
  PreparedSessionMentionInvitation,
  SessionMentionInvitation,
} from "../config/sessions/session-sharing-authority.types.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
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
  onOriginalInputCommitted?: (anchor: TranscriptEntryAnchor) => void;
  prepareMentionInvitation?: (
    message: PersistedUserTurnMessage,
  ) => PreparedSessionMentionInvitation | undefined;
  requesterOrigin: () => RequesterOrigin | undefined;
  promptReactionSource?: UserTurnPromptReactionSource;
  pendingInput: () => SessionPendingInputReceipt | undefined;
  withdrawnInputId: () => string | undefined;
  receipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  message: () => PersistedUserTurnMessage | undefined;
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
  owner: AdmissionOwner,
): void {
  admissionOwners.set(recorder, owner);
}

export function getUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
): AdmissionOwner | undefined {
  return admissionOwners.get(recorder);
}

// Invitation plans travel with the exact host-owned guard, never SDK append options.
const mentionCommitInvitations = new WeakMap<() => void, SessionMentionInvitation>();

export function prepareUserTurnMessageCommit(
  recorder: UserTurnTranscriptRecorder | undefined,
  message: AgentMessage,
): (() => void) | undefined {
  const owner = recorder && admissionOwners.get(recorder);
  const prepared =
    message.role === "user" &&
    owner &&
    !owner.blocked() &&
    !owner.pendingInput() &&
    !owner.receipt()
      ? owner.prepareMentionInvitation?.(message)
      : undefined;
  const assertCommit = recorder?.assertOriginalInputCommit;
  if (!assertCommit && !prepared) {
    return undefined;
  }
  const assertCurrent = createMessageInjectionAuthority(() => {
    assertCommit?.();
    prepared?.assertCurrent();
    return true;
  });
  if (prepared) {
    mentionCommitInvitations.set(assertCurrent, prepared.invitation);
  }
  return assertCurrent;
}

export function readUserTurnMentionInvitation(
  assertCurrent: (() => void) | undefined,
): SessionMentionInvitation | undefined {
  return assertCurrent && mentionCommitInvitations.get(assertCurrent);
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

/** Only producer facts or exact accepted custody may supply fresh write identity. */
export function projectUserTurnRequesterOrigin<T extends PersistedUserTurnMessage | undefined>(
  candidate: T,
  requesterOrigin: RequesterOrigin | undefined,
): T {
  if (!candidate) {
    return candidate;
  }
  const { requesterOrigin: _previousOrigin, ...metadata } = candidate["__openclaw"] ?? {};
  if (requesterOrigin) {
    metadata.requesterOrigin = requesterOrigin;
  }
  const next = { ...candidate };
  delete next["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    next["__openclaw"] = metadata;
  }
  return next;
}

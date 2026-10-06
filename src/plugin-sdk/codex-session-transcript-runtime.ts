import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptMessageAppendResult } from "../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  readSessionTranscriptContextMessages,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextVersion,
} from "../config/sessions/session-accessor.sqlite-model-context.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.types.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { SessionTranscriptContextReader } from "../config/sessions/session-transcript-context-reader.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
  withSessionContextAdmission,
} from "../config/sessions/session-transcript-read-fence.js";
import type {
  TranscriptTurnAdmission,
  TranscriptEntryAnchor,
} from "../config/sessions/transcript-entry-anchor.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { IncognitoSessionSyncAccessError } from "../state/incognito-session-error.js";
import type { AgentMessage } from "./agent-core.js";
import type {
  InternalSessionTranscriptWriteLockContext,
  InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import type { SessionTranscriptTargetParams } from "./session-transcript-runtime.js";

export { resolveSessionTranscriptReadFence as captureCodexSessionTranscriptReadAdmission } from "../config/sessions/session-transcript-read-fence.js";
export type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
export { SessionTranscriptReadFenceError };

export {
  createSessionTranscriptContextReader as createCodexSessionContextReader,
  type SessionTranscriptContextReader as CodexSessionContextReader,
} from "../config/sessions/session-transcript-context-reader.js";
export type { SessionTranscriptContextSnapshot as CodexSessionContextSnapshot } from "../config/sessions/session-history-read.types.js";

/** Capture the admitted actor before yielding; ordinary host-owned routing stays unchanged. */
export function captureCodexSessionContextReader(
  source: SessionTranscriptRuntimeTarget,
  signal?: AbortSignal,
): SessionTranscriptContextReader | undefined {
  const binding = captureIncognitoSessionBinding(source);
  if (!binding) {
    return undefined;
  }
  const target = captureSessionTranscriptTargetBinding(source);
  const { actor } = binding;
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    binding.admissionSignal?.throwIfAborted();
    assertOwned();
    actor.assertCurrent();
    claim.assertCurrent();
  };
  assertCurrent();
  const input = {
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleRevision: actor.sessions.readSharing(target.sessionKey)?.entry?.lifecycleRevision,
    admission: resolveSessionTranscriptReadFence(target),
  };
  return async (readTarget, read) => {
    const value = await actor.sessions.withSharedState(async () => {
      assertCurrent();
      const { bindIncognitoSessionComputeReader } =
        await import("../config/sessions/session-incognito-compute-read.js");
      assertCurrent();
      return bindIncognitoSessionComputeReader({
        actor,
        authority: { assertCurrent },
        target: input,
        signal,
      }).nativeContext(readTarget, read);
    });
    assertCurrent();
    actor.assertReadable();
    return value;
  };
}

function assertCodexSessionSyncAccess(target: SessionTranscriptReadScope, method: string) {
  if (captureIncognitoSessionBinding(target)) {
    throw new IncognitoSessionSyncAccessError(method, "captureCodexSessionContextReader");
  }
}

/** Actor reads validate through the captured awaited context reader. */
export function validateCodexSessionTranscriptReadAdmission(
  ...args: Parameters<typeof validateSessionTranscriptContextAdmission>
): void {
  assertCodexSessionSyncAccess(args[0], "validateCodexSessionTranscriptReadAdmission");
  validateSessionTranscriptContextAdmission(...args);
}

/** Actor reads validate through the captured awaited context reader. */
export function validateCodexSessionTranscriptContextVersion(
  ...args: Parameters<typeof validateSessionTranscriptContextVersion>
): void {
  assertCodexSessionSyncAccess(args[0], "validateCodexSessionTranscriptContextVersion");
  validateSessionTranscriptContextVersion(...args);
}

/** The native evidence consumer remains lazy inside one readonly transcript snapshot. */
export function readCodexSessionContext<T>(
  target: SessionTranscriptRuntimeTarget,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
  admission?: TranscriptTurnAdmission,
): T {
  assertCodexSessionSyncAccess(target, "readCodexSessionContext");
  return withSessionContextAdmission(target, admission, () =>
    readSessionTranscriptContextMessages(target, read),
  );
}

/** Reads the bundled Codex mirror strictly before one admitted user row. */
export async function readCodexSessionTranscriptEventsBeforeAdmission(
  params: SessionTranscriptTargetParams,
  admission: TranscriptTurnAdmission,
) {
  const { readSessionTranscriptEvents, resolveSessionTranscriptIdentity } =
    await import("./session-transcript-runtime.js");
  const target = await resolveSessionTranscriptIdentity(params);
  if (
    target.agentId !== admission.agentId ||
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return await runWithSessionTranscriptReadFence(
    admission,
    async () => await readSessionTranscriptEvents(params),
  );
}

export type CodexSessionTranscriptMirrorWriteLockContext =
  InternalSessionTranscriptWriteLockContext & {
    appendMessageWithMessageSequence: <TMessage>(
      options: Omit<LockedTranscriptMessageAppendOptions<TMessage>, "config">,
    ) => Promise<{
      lifecycleRevision?: string;
      messageSeq?: number;
      result: TranscriptMessageAppendResult<TMessage> | undefined;
    }>;
    readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
      anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
      existingIdempotencyKeys: Set<string>;
      messagesByIdempotencyKey: Map<string, AgentMessage>;
    }>;
  };

/** Runs the bundled Codex mirror under the transcript writer lock. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const { withProjectedSessionTranscriptWriteLock } =
    await import("./session-transcript-lock-runtime.js");
  return await withProjectedSessionTranscriptWriteLock(params, run, (context, locked) => ({
    ...context,
    appendMessageWithMessageSequence: (options) =>
      locked.appendMessageWithMessageSequence({
        ...options,
        ...(params.config !== undefined ? { config: params.config } : {}),
      }),
    readMessageFacts: async (factParams) => {
      const facts = await locked.readMessageFacts(factParams);
      const messagesByIdempotencyKey = new Map<string, AgentMessage>();
      for (const [idempotencyKey, message] of facts.messagesByIdempotencyKey) {
        if (isAgentMessageRecord(message)) {
          messagesByIdempotencyKey.set(idempotencyKey, message);
        }
      }
      return { ...facts, messagesByIdempotencyKey };
    },
  }));
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}

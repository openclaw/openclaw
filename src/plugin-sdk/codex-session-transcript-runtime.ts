import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptMessageAppendResult } from "../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  readSessionTranscriptContextMessages,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextVersion,
} from "../config/sessions/session-accessor.sqlite-model-context.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.types.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { prepareIncognitoSessionHistoryRead } from "../config/sessions/session-incognito-history-read.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { SessionTranscriptContextProjectionSource } from "../config/sessions/session-transcript-context-read.js";
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
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { IncognitoSessionSyncAccessError } from "../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { AgentMessage } from "./agent-core.js";
import type {
  InternalSessionTranscriptWriteLockContext,
  InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import type {
  SessionTranscriptTargetParams,
  SessionTranscriptWriteContext,
} from "./session-transcript-runtime.js";

export { resolveSessionTranscriptReadFence as captureCodexSessionTranscriptReadAdmission } from "../config/sessions/session-transcript-read-fence.js";
export type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
export { SessionTranscriptReadFenceError };

export {
  createSessionTranscriptContextReader as createCodexSessionContextReader,
  type SessionTranscriptContextReader as CodexSessionContextReader,
} from "../config/sessions/session-transcript-context-reader.js";
export type { SessionTranscriptContextSnapshot as CodexSessionContextSnapshot } from "../config/sessions/session-history-read.types.js";
export type { SessionTranscriptContextProjectionSource };
export { readSessionTranscriptContextProjectionAsync as readCodexSessionContextProjection } from "../config/sessions/session-transcript-context-read.js";

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
      const prepared = prepareIncognitoSessionHistoryRead(
        { actor, authority: { assertCurrent }, target: input },
        { ...readTarget, env: target.env },
        signal,
      );
      return bindIncognitoSessionComputeReader({ ...prepared, signal }).nativeContext(
        { ...readTarget, storePath: actor.path },
        read,
      );
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

/** @deprecated Synchronous SDK compatibility until the next major; bundled readers retain worker validation. */
export function validateCodexSessionTranscriptReadAdmission(
  ...args: Parameters<typeof validateSessionTranscriptContextAdmission>
): void {
  assertCodexSessionSyncAccess(args[0], "validateCodexSessionTranscriptReadAdmission");
  validateSessionTranscriptContextAdmission(...args);
}

/** @deprecated Synchronous SDK compatibility until the next major; bundled readers retain worker validation. */
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
  physicalSource?: SessionTranscriptContextProjectionSource["physicalSource"],
): T {
  assertCodexSessionSyncAccess(target, "readCodexSessionContext");
  if (physicalSource) {
    const databasePath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(target)),
    );
    const identity = physicalSource.expectedIdentity;
    if (identity) {
      assertExistingDatabaseIdentity(databasePath, identity.key, identity.birthtime);
    } else if (readDatabasePathIdentitySync(databasePath).key.startsWith("file:")) {
      throw new Error("Session context changed its captured database owner");
    }
  }
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

export type CodexSessionTranscriptMirrorWriteLockContext = Omit<
  InternalSessionTranscriptWriteLockContext,
  "readMessageFacts"
> & {
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

/** @deprecated Use withCodexSessionTranscriptMirrorWrite. Removed at the next Plugin SDK major. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  return withMirrorWrite(params, run, "lock");
}

export type CodexSessionTranscriptMirrorWriteContext = Omit<
  SessionTranscriptWriteContext,
  "readMessageFacts"
> & {
  readMessageFacts: CodexSessionTranscriptMirrorWriteLockContext["readMessageFacts"];
  appendMessageWithMessageSequence: <TMessage>(
    options: Omit<
      LockedTranscriptMessageAppendOptions<TMessage>,
      | "config"
      | "prepareMessageAfterIdempotencyCheck"
      | "prepareMessageAfterIdempotencyCheckAsync"
      | "beforeFreshMessageCommit"
    >,
  ) => Promise<{
    lifecycleRevision?: string;
    messageSeq?: number;
    result: TranscriptMessageAppendResult<TMessage> | undefined;
  }>;
};

/**
 * Runs ordered optimistic mirror writes and returns each committed message's sequence.
 * `assertCurrent` guards every commit; it is prepared before the writer is reserved,
 * because its session-row reads cannot run while this write holds the database.
 */
export async function withCodexSessionTranscriptMirrorWrite<T>(
  params: InternalSessionTranscriptWriteLockParams & { assertCurrent?: SessionSourceAssertion },
  run: (context: CodexSessionTranscriptMirrorWriteContext) => Promise<T> | T,
): Promise<T> {
  const { assertCurrent, ...scope } = params;
  return assertCurrent
    ? withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
        withMirrorWrite(scope, run, "sequence"),
      )
    : withMirrorWrite(scope, run, "sequence");
}

async function withMirrorWrite<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
  mode: "lock" | "sequence",
): Promise<T> {
  const { withProjectedSessionTranscriptWriteLock } =
    await import("./session-transcript-lock-runtime.js");
  return await withProjectedSessionTranscriptWriteLock(
    params,
    run,
    (context, locked) => ({
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
    }),
    mode,
  );
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}

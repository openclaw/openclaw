// Transcript write contexts carry the admitted run fence and teardown tracking
// through nested session-manager callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type {
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
} from "../../agents/sessions/session-manager-types.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { getCliHistoryWriter, runWithCliHistoryWriter } from "./cli-history-boundary.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import type { SessionActor } from "./session-actor-contract.js";
import {
  assertSessionEntryCohortScope,
  matchSessionEntryCohortScope,
} from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type {
  InitialSessionTranscriptWriter,
  SessionTranscriptWriterFence,
} from "./session-transcript-writer.types.js";
import {
  captureSessionTranscriptStorageEnvironment,
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptStorageEnvironment,
  sameSessionTranscriptTargetBinding,
  type SessionTranscriptTargetBinding,
} from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
export type {
  InitialSessionTranscriptWriter,
  SessionTranscriptWriterFence,
} from "./session-transcript-writer.types.js";

export type SessionMetadataChange =
  | Pick<ModelChangeEntry, "type" | "provider" | "modelId">
  | Pick<ThinkingLevelChangeEntry, "type" | "thinkingLevel">;

type MetadataTarget = SessionTranscriptTargetBinding;
type MetadataPublicationOwner = {
  getSessionId(): string;
  getSessionTarget(): MetadataTarget | undefined;
};
export type SessionMetadataCommit = {
  entry: ModelChangeEntry | ThinkingLevelChangeEntry;
  version: SessionTranscriptContextVersion | undefined;
  target: MetadataTarget | undefined;
};
type MetadataPublication = {
  owner: MetadataPublicationOwner;
  sessionId: string;
  target: MetadataTarget | undefined;
  change: SessionMetadataChange;
  publish: (commit: SessionMetadataCommit) => undefined;
};

type SessionTranscriptWriteTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  expectedOwner?: SessionTranscriptWriteScope["expectedOwner"];
};

export type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteTarget;
  initialWriter?: InitialSessionTranscriptWriter;
  sessionReader?: SessionEntryCohortReader;
  sessionActor?: {
    actor: SessionActor;
    /** Retain the physical database owner, independently of the logical session agent. */
    database: Readonly<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>;
  };
  /** Revalidate the captured owner, including an absent writer, inside each commit. */
  assertCommitAllowed?: SessionSourceAssertion;
  withTranscriptWrite: <T>(run: () => Promise<T> | T) => Promise<T>;
  metadataPublication?: { current?: MetadataPublication };
};

type SessionTranscriptWriteRequest = Pick<
  OwnedSessionTranscriptWriteContext,
  "sessionFile" | "sessionKey" | "sessionTarget"
>;

type TranscriptSourcePublication = {
  target: SessionTranscriptWriteTarget;
  claimed: boolean;
  publish?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<
  OwnedSessionTranscriptWriteContext & { sourcePublication?: TranscriptSourcePublication }
>();

/** Bind an initiating write's acknowledged source before fallible publication observers. */
export async function withSessionTranscriptSourcePublication<T>(
  target: SessionTranscriptWriteTarget,
  publish: NonNullable<TranscriptSourcePublication["publish"]>,
  run: () => Promise<T>,
): Promise<T> {
  const parent = ownedTranscriptWriteContext.getStore();
  const publication: TranscriptSourcePublication = {
    target: captureWriteTarget(target),
    claimed: false,
    publish,
  };
  try {
    return await ownedTranscriptWriteContext.run(
      {
        ...parent,
        withTranscriptWrite: parent ? (write) => parent.withTranscriptWrite(write) : trackAsyncWork,
        sourcePublication: publication,
      },
      run,
    );
  } finally {
    publication.publish = undefined;
  }
}

export function captureSessionTranscriptSourcePublication(
  target: SessionTranscriptWriteTarget,
): TranscriptSourcePublication["publish"] {
  const publication = ownedTranscriptWriteContext.getStore()?.sourcePublication;
  if (
    !publication ||
    publication.claimed ||
    !contextMatches({
      context: { sessionTarget: publication.target, withTranscriptWrite: trackAsyncWork },
      sessionTarget: captureWriteTarget(target),
    })
  ) {
    return undefined;
  }
  publication.claimed = true;
  return (source, entry) => publication.publish?.(source, entry);
}

/** Borrow the selected physical owner only for this exact admitted transcript. */
export function getOwnedSessionTranscriptReader(scope: SessionTranscriptWriteTarget) {
  const context = ownedTranscriptWriteContext.getStore();
  const reader = context?.sessionReader;
  const original = context?.sessionTarget;
  if (
    !reader ||
    !scope.sessionKey ||
    !original?.sessionKey ||
    original.sessionId !== scope.sessionId
  ) {
    return undefined;
  }
  if (!matchSessionEntryCohortScope(reader, { sessionKey: scope.sessionKey })) {
    return undefined;
  }
  assertSessionEntryCohortScope(reader, { ...original, sessionKey: original.sessionKey });
  assertSessionEntryCohortScope(reader, {
    ...captureWriteTarget(scope),
    sessionKey: scope.sessionKey,
  });
  context.assertCommitAllowed?.();
  return reader;
}

/** Borrow only the actor retained for this exact admitted transcript. */
export function getOwnedSessionTranscriptActor(
  scope: SessionTranscriptWriteTarget,
): OwnedSessionTranscriptWriteContext["sessionActor"] {
  const context = ownedTranscriptWriteContext.getStore();
  const actor = context?.sessionActor;
  if (!actor) {
    return undefined;
  }
  if (
    !contextMatches({ context, sessionTarget: captureWriteTarget(scope) }) ||
    context.sessionTarget?.sessionId !== scope.sessionId ||
    context.sessionTarget?.agentId !== scope.agentId
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  context.assertCommitAllowed?.();
  actor.actor.assertCurrent();
  return actor;
}

function captureWriteTarget(target: SessionTranscriptWriteTarget): SessionTranscriptWriteTarget {
  const storePath = target.storePath?.trim();
  return {
    ...(storePath
      ? captureSessionTranscriptTargetBinding({ ...target, storePath })
      : { ...target, env: captureSessionTranscriptStorageEnvironment(target.env ?? process.env) }),
    ...(target.expectedOwner ? { expectedOwner: { ...target.expectedOwner } } : {}),
  };
}

function captureWriteContext(
  context: OwnedSessionTranscriptWriteContext,
): OwnedSessionTranscriptWriteContext {
  return context.sessionTarget
    ? { ...context, sessionTarget: captureWriteTarget(context.sessionTarget) }
    : context;
}

function sameMetadataChange(left: SessionMetadataChange, right: SessionMetadataChange): boolean {
  return left.type === "model_change"
    ? right.type === left.type && left.provider === right.provider && left.modelId === right.modelId
    : right.type === left.type && left.thinkingLevel === right.thinkingLevel;
}

/** Couple one metadata append to its caller's synchronous state publication. */
export async function withSessionMetadataPublication<T>(
  owner: MetadataPublicationOwner,
  change: SessionMetadataChange,
  publish: (commit: SessionMetadataCommit) => undefined,
  run: () => Promise<T>,
): Promise<T> {
  const parent = ownedTranscriptWriteContext.getStore();
  const target = owner.getSessionTarget();
  const publication: MetadataPublication = {
    owner,
    sessionId: owner.getSessionId(),
    target,
    change,
    publish,
  };
  const metadataPublication: { current?: MetadataPublication } = { current: publication };
  try {
    return await ownedTranscriptWriteContext.run(
      {
        ...parent,
        withTranscriptWrite: parent ? (write) => parent.withTranscriptWrite(write) : trackAsyncWork,
        metadataPublication,
      },
      run,
    );
  } finally {
    metadataPublication.current = undefined;
  }
}

/** Claim before the append yields, so a reentrant observer cannot take its publisher. */
export function captureSessionMetadataPublication(
  owner: MetadataPublicationOwner,
  change: SessionMetadataChange,
): {
  sessionId: string;
  target: MetadataTarget | undefined;
  publish: (commit: SessionMetadataCommit) => undefined;
} {
  const currentTarget = owner.getSessionTarget();
  const captured = {
    sessionId: owner.getSessionId(),
    target: currentTarget,
  };
  const slot = ownedTranscriptWriteContext.getStore()?.metadataPublication;
  if (!slot?.current) {
    return { ...captured, publish: () => undefined };
  }
  const publication = slot.current;
  if (
    publication.owner !== owner ||
    publication.sessionId !== owner.getSessionId() ||
    !sameSessionTranscriptTargetBinding(publication.target, owner.getSessionTarget()) ||
    !sameMetadataChange(publication.change, change)
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  slot.current = undefined;
  return {
    ...captured,
    publish: (commit) => {
      if (
        publication.sessionId !== owner.getSessionId() ||
        !sameSessionTranscriptTargetBinding(publication.target, owner.getSessionTarget())
      ) {
        return undefined;
      }
      if (
        !sameSessionTranscriptTargetBinding(publication.target, commit.target) ||
        !sameMetadataChange(publication.change, commit.entry)
      ) {
        throw new Error("Committed metadata differs from its publication owner");
      }
      publication.publish(commit);
      return undefined;
    },
  };
}

// Compare concrete files when available; SQLite markers fall back to session
// identity because they are storage references rather than filesystem paths.
function normalizeConcretePathForCompare(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || !trimmed.endsWith(".jsonl")) {
    return undefined;
  }
  return path.resolve(trimmed);
}

function contextMatches(
  params: SessionTranscriptWriteRequest & { context: OwnedSessionTranscriptWriteContext },
): boolean {
  const normalizeTarget = (target: SessionTranscriptWriteTarget | undefined) => {
    const agentId = target?.agentId?.trim();
    const sessionId = target?.sessionId?.trim();
    const sessionKey = target?.sessionKey?.trim();
    const storePath = target?.storePath?.trim();
    return sessionKey && storePath
      ? { agentId, sessionId, sessionKey, storePath, env: target?.env }
      : undefined;
  };
  const contextTarget = normalizeTarget(params.context.sessionTarget);
  const requestedTarget = normalizeTarget(params.sessionTarget);
  if (params.context.sessionTarget || params.sessionTarget) {
    return Boolean(
      contextTarget &&
      requestedTarget &&
      contextTarget.sessionKey === requestedTarget.sessionKey &&
      contextTarget.storePath === requestedTarget.storePath &&
      sameSessionTranscriptStorageEnvironment(contextTarget.env, requestedTarget.env) &&
      (!contextTarget.agentId ||
        !requestedTarget.agentId ||
        contextTarget.agentId === requestedTarget.agentId) &&
      (!contextTarget.sessionId ||
        !requestedTarget.sessionId ||
        contextTarget.sessionId === requestedTarget.sessionId),
    );
  }
  const contextSessionFile = normalizeConcretePathForCompare(params.context.sessionFile);
  const sessionFile = normalizeConcretePathForCompare(params.sessionFile);
  if (contextSessionFile && sessionFile) {
    return contextSessionFile === sessionFile;
  }

  const contextSessionKey = params.context.sessionKey?.trim();
  const sessionKey = params.sessionKey?.trim();
  return Boolean(contextSessionKey && sessionKey && contextSessionKey === sessionKey);
}

/**
 * Ownership test for a writer fence, which is the one gate a caller can reach holding
 * nothing but a session key. A delivery mirror knows the session it writes into but not
 * that session's store path, so it cannot form a target; `contextMatches` would refuse
 * it for not being target-shaped and leave it unable to tell "the running session" from
 * "some other session". Compare keys in that case, and defer to the target comparison
 * whenever the caller can express one.
 */
function ownsRequestedSession(
  params: SessionTranscriptWriteRequest & { context: OwnedSessionTranscriptWriteContext },
): boolean {
  if (params.sessionTarget || params.sessionFile) {
    return contextMatches(params);
  }
  const contextSessionKey = (
    params.context.sessionTarget?.sessionKey ?? params.context.sessionKey
  )?.trim();
  const sessionKey = params.sessionKey?.trim();
  return Boolean(contextSessionKey && sessionKey && contextSessionKey === sessionKey);
}

/** Runs transcript writes with the admitted run's teardown and writer-fence context. */
export async function withOwnedSessionTranscriptWrites<T>(
  context: OwnedSessionTranscriptWriteContext,
  run: () => Promise<T>,
): Promise<T> {
  return await ownedTranscriptWriteContext.run(captureWriteContext(context), run);
}

/** Add a caller's live capability without replacing its admitted writer or settlement owner. */
export function withSessionTranscriptWriteAssertion<T>(
  scope: SessionTranscriptWriteTarget,
  assertCurrent: () => void,
  run: () => T,
): T {
  const parent = ownedTranscriptWriteContext.getStore();
  const target = captureWriteTarget(scope);
  assertTranscriptWriteContext(parent, target);
  assertCurrent();
  return ownedTranscriptWriteContext.run(
    {
      ...parent,
      sessionTarget: parent?.sessionTarget ?? target,
      assertCommitAllowed: composeSessionSourceAssertion([
        captureExternalSessionCommitGuard(parent?.assertCommitAllowed),
        captureExternalSessionCommitGuard(assertCurrent),
      ]),
      withTranscriptWrite: parent ? (write) => parent.withTranscriptWrite(write) : trackAsyncWork,
    },
    run,
  );
}

/** Runs detached work without retaining an attempt-owned transcript context. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(undefined, run));
}

export function bindOwnedSessionTranscriptWrites<TArgs extends unknown[], TResult>(
  context: OwnedSessionTranscriptWriteContext,
  run: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const captured = captureWriteContext(context);
  return (...args) => ownedTranscriptWriteContext.run(captured, () => run(...args));
}

/**
 * Returns the matching admitted-run fence for a durable write boundary.
 *
 * Every write boundary must name the session it writes into, or it inherits a claim
 * about whichever session happens to be running. Omitting the scope asks for the
 * ambient claim itself and is only for diagnostics that observe the running writer.
 */
export function getOwnedSessionTranscriptWriterFence(
  params: SessionTranscriptWriteRequest = {},
): SessionTranscriptWriterFence | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (
    context &&
    Object.keys(params).length > 0 &&
    !ownsRequestedSession({
      context,
      ...params,
      sessionTarget: params.sessionTarget ? captureWriteTarget(params.sessionTarget) : undefined,
    })
  ) {
    return undefined;
  }
  const initial = context?.initialWriter;
  if (initial) {
    return (
      initial.committedFence ?? {
        expectedLifecycleRevision: undefined,
        expectedWriterRunId: initial.writerRunId,
      }
    );
  }
  const target = context?.sessionTarget;
  const expectedWriterRunId = target?.expectedWriterRunId?.trim();
  if (expectedWriterRunId) {
    return { expectedLifecycleRevision: target?.expectedLifecycleRevision, expectedWriterRunId };
  }
  // Direct CLI recovery carries its claim in the account-bound capability.
  // The common transcript fence must retain it across awaited write preparation.
  const cliWriter = params.sessionTarget && getCliHistoryWriter(params.sessionTarget);
  cliWriter?.assertCurrent();
  return cliWriter
    ? {
        expectedLifecycleRevision: cliWriter.lifecycleRevision,
        expectedWriterRunId: cliWriter.runId,
      }
    : undefined;
}

/** Inherit only the exact host-minted first-insert owner across attempt preparation. */
export function getOwnedSessionTranscriptInitialWriter(
  params: SessionTranscriptWriteRequest,
): InitialSessionTranscriptWriter | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context?.initialWriter) {
    return undefined;
  }
  if (
    !contextMatches({
      context,
      ...params,
      sessionTarget: params.sessionTarget ? captureWriteTarget(params.sessionTarget) : undefined,
    }) ||
    context.sessionTarget?.sessionId !== params.sessionTarget?.sessionId ||
    context.sessionTarget?.agentId !== params.sessionTarget?.agentId
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return context.initialWriter;
}

function assertTranscriptWriteContext(
  context: OwnedSessionTranscriptWriteContext | undefined,
  scope: SessionTranscriptWriteTarget,
  assertSource = () => {
    context?.assertCommitAllowed?.();
    context?.initialWriter?.assertActive();
  },
): void {
  if (!context?.assertCommitAllowed && !context?.initialWriter) {
    return;
  }
  if (
    !contextMatches({ context, sessionTarget: scope }) ||
    context.sessionTarget?.sessionId !== scope.sessionId ||
    context.sessionTarget?.agentId !== scope.agentId
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  assertSource();
}

/** A guarded context cannot silently become an unfenced write to another target. */
export function assertOwnedTranscriptWriteCommit(scope: SessionTranscriptWriteTarget): void {
  assertTranscriptWriteContext(ownedTranscriptWriteContext.getStore(), captureWriteTarget(scope));
}

/** Retained post-commit work must revalidate its original owner, not its invocation context. */
export function captureOwnedTranscriptWriteAssertion(
  scope: SessionTranscriptWriteTarget,
): SessionSourceAssertion {
  const context = ownedTranscriptWriteContext.getStore();
  const target = captureWriteTarget(scope);
  return composeSessionSourceAssertion(
    [
      captureExternalSessionCommitGuard(context?.assertCommitAllowed),
      context?.initialWriter?.assertActive,
    ],
    (assertSource) => assertTranscriptWriteContext(context, target, assertSource),
  );
}

/** Applies the admitted-run fence inherited by a matching writer. */
export function withOwnedSessionTranscriptWriterFence<T extends SessionTranscriptWriteTarget>(
  scope: T,
): T {
  const target = captureWriteTarget(scope);
  const fence = getOwnedSessionTranscriptWriterFence({
    sessionKey: target.sessionKey,
    sessionTarget: target,
  });
  const context = ownedTranscriptWriteContext.getStore();
  const expectedOwner = context?.sessionTarget?.expectedOwner;
  if (expectedOwner && context && ownsRequestedSession({ context, sessionTarget: target })) {
    return { ...scope, ...fence, expectedOwner: { ...expectedOwner } };
  }
  return fence ? { ...scope, ...fence } : scope;
}

export async function runWithOwnedSessionTranscriptWrite<T>(
  params: SessionTranscriptWriteRequest,
  run: () => Promise<T> | T,
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (
    !context ||
    !contextMatches({
      context,
      ...params,
      sessionTarget: params.sessionTarget ? captureWriteTarget(params.sessionTarget) : undefined,
    })
  ) {
    return await run();
  }
  return await context.withTranscriptWrite(run);
}

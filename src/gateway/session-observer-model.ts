import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import {
  SESSION_OBSERVER_HEALTH_VALUES,
  type SessionObserverDigest,
  type SessionObserverHealth,
  type SessionObserverPlanProgress,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import {
  terminalHealthFor,
  type SessionActivityNoteState,
} from "../agents/session-activity-notes.js";
import type {
  runUtilityCompletion,
  prepareUtilityCompletionForAgent,
} from "../agents/utility-completion.js";
import { resolveSessionObserverDigestForLifecycle } from "../config/sessions/observer-digest.js";
import {
  applySessionEntryOperation,
  applySessionEntryTargetOperation,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { pruneMapToMaxSize, touchBoundedSet } from "../infra/map-size.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

const HEADLINE_MAX_CHARS = 120;
const ASSESSMENT_MAX_CHARS = 320;
const MAX_REVISION_FLOORS = 256;
const MAX_SUPERSEDED_RUNS = 256;
const MAX_DORMANT_RUNS = 256;
const MAX_DISABLED_RUNS = 512;

export type SessionObserverRead = {
  assertCurrent: () => void;
  withRead: <T>(consume: (session: SessionEntry | undefined) => T) => Promise<T>;
  persist: NonNullable<SessionObserverDeps["persistDigest"]>;
};

export function sessionObserverScopeKey(sessionKey: string, agentId: string): string {
  return parseAgentSessionKey(sessionKey)
    ? sessionKey
    : `agent:${normalizeAgentId(agentId)}:${sessionKey}`;
}
type PrepareModel = typeof prepareUtilityCompletionForAgent;
type CompleteModel = typeof runUtilityCompletion;
type PreparedModel = Awaited<ReturnType<PrepareModel>>;

type SessionObserverLifecycle = Pick<SessionObserverDigest, "sessionId" | "lifecycleRevision">;

export function isSameSessionObserverLifecycle(
  left: SessionObserverLifecycle | undefined,
  right: SessionObserverLifecycle | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.sessionId === right.sessionId &&
    left.lifecycleRevision === right.lifecycleRevision
  );
}

export type SessionObserverState = SessionActivityNoteState & {
  reader?: SessionObserverRead;
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  runId: string;
  agentId: string;
  utilityModelRef?: string;
  startedAt: number;
  lastActivityAt: number;
  lastRunAt: number;
  lastPersistedAt?: number;
  revision: number;
  digestCount: number;
  consecutiveFailures: number;
  lastDigestNoteSequence: number;
  lastPreambleHeadline?: string;
  lastPublishedPreambleHeadline?: string;
  previousDigest?: SessionObserverDigest;
  preparedPromise?: Promise<PreparedModel>;
  activeController?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  finalPending: boolean;
  terminalHealth?: "done" | "failed";
};

export type DormantSessionObserverRun = Pick<
  SessionObserverState,
  | "reader"
  | "sessionKey"
  | "sessionId"
  | "lifecycleRevision"
  | "runId"
  | "agentId"
  | "utilityModelRef"
  | "startedAt"
  | "lastPersistedAt"
  | "revision"
  | "digestCount"
  | "consecutiveFailures"
  | "lastPreambleHeadline"
  | "planProgress"
  | "previousDigest"
>;

export type SessionObserverRevisionFloor = Pick<
  DormantSessionObserverRun,
  "reader" | "sessionId" | "lifecycleRevision" | "revision" | "previousDigest"
>;

export function snapshotSessionObserverRevisionFloor({
  reader,
  sessionId,
  lifecycleRevision,
  revision,
  previousDigest,
}: SessionObserverRevisionFloor): SessionObserverRevisionFloor {
  return { ...(reader ? { reader } : {}), sessionId, lifecycleRevision, revision, previousDigest };
}

export function rememberSessionObserverRevisionFloor(
  floors: Map<string, SessionObserverRevisionFloor>,
  sessionKey: string,
  candidate: SessionObserverRevisionFloor,
): void {
  const current = floors.get(sessionKey);
  if (
    !current ||
    !isSameSessionObserverLifecycle(current, candidate) ||
    candidate.revision > current.revision
  ) {
    floors.delete(sessionKey);
    floors.set(sessionKey, candidate);
  }
  pruneMapToMaxSize(floors, MAX_REVISION_FLOORS);
}

export function rememberSessionObserverDormantRun(
  runs: Map<string, DormantSessionObserverRun>,
  floors: Map<string, SessionObserverRevisionFloor>,
  run: DormantSessionObserverRun,
): void {
  runs.delete(run.runId);
  runs.set(run.runId, run);
  while (runs.size > MAX_DORMANT_RUNS) {
    const oldest = runs.entries().next();
    if (oldest.done) {
      break;
    }
    const [runId, evicted] = oldest.value;
    runs.delete(runId);
    // Retain revision continuity so a later resume cannot restart below a broadcast revision.
    rememberSessionObserverRevisionFloor(
      floors,
      resolveSessionSubscriptionKey(evicted.sessionKey, evicted.agentId),
      snapshotSessionObserverRevisionFloor(evicted),
    );
  }
}

export function rememberSessionObserverDisabledRun(runs: Set<string>, runId: string): void {
  touchBoundedSet(runs, runId, MAX_DISABLED_RUNS);
}

export function markSessionObserverRunSuperseded(
  runs: Map<string, number>,
  runId: string,
  observedAt: number,
): void {
  runs.delete(runId);
  runs.set(runId, observedAt);
  pruneMapToMaxSize(runs, MAX_SUPERSEDED_RUNS);
}

export function createDormantSessionObserverRun(
  state: SessionObserverState,
): DormantSessionObserverRun {
  return {
    reader: state.reader,
    sessionKey: state.sessionKey,
    sessionId: state.sessionId,
    lifecycleRevision: state.lifecycleRevision,
    runId: state.runId,
    agentId: state.agentId,
    ...(state.utilityModelRef ? { utilityModelRef: state.utilityModelRef } : {}),
    startedAt: state.startedAt,
    lastPersistedAt: state.lastPersistedAt,
    revision: state.revision,
    digestCount: state.digestCount,
    consecutiveFailures: state.consecutiveFailures,
    ...(state.lastPublishedPreambleHeadline
      ? { lastPreambleHeadline: state.lastPublishedPreambleHeadline }
      : {}),
    planProgress: state.planProgress,
    previousDigest: state.previousDigest,
  };
}

export type SessionObserverDeps = {
  getConfig: () => OpenClawConfig;
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  prepareModel?: PrepareModel;
  completeModel?: CompleteModel;
  readSession?: (sessionKey: string, agentId: string) => SessionEntry | undefined;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  persistDigest?: (params: {
    reader?: SessionObserverRead;
    sessionKey: string;
    sessionId?: string;
    agentId: string;
    digest: SessionObserverDigest;
    /** Evaluated inside the entry updater so run rollover cannot commit a
     * digest from a replaced run between acceptance and the async write. */
    stillCurrent?: () => boolean;
  }) => Promise<boolean | null>;
};

export async function defaultPrepareModel(params: Parameters<PrepareModel>[0]) {
  const { prepareUtilityCompletionForAgent } = await import("../agents/utility-completion.js");
  return await prepareUtilityCompletionForAgent(params);
}

export async function defaultCompleteModel(params: Parameters<CompleteModel>[0]) {
  const { runUtilityCompletion } = await import("../agents/utility-completion.js");
  return await runUtilityCompletion(params);
}

export const SESSION_OBSERVER_SYSTEM_PROMPT = [
  "You judge the trajectory of a running AI agent session for an operator status surface.",
  "Judge whether the agent is progressing, grinding through necessary work, stuck in a repeated failing loop, waiting on the user, wrapping up, done, or failed.",
  "Do not transcribe the activity log. Summarize what it is doing and how it is going.",
  "Use American English and present tense. Do not use markdown in string values.",
  'Set health to exactly one of "on-track", "grinding", "stuck", "waiting-on-user", "wrapping-up", "done", or "failed".',
  'Return one raw JSON object only, without Markdown fences or surrounding text, for example: {"headline":"Checking the fix","assessment":"Tests are passing.","health":"on-track","planProgress":{"completed":2,"total":3}}. Omit optional fields instead of setting them to null.',
].join(" ");

const ModelDigestSchema = z.strictObject({
  headline: z.string().min(1),
  assessment: z.string().min(1).optional(),
  health: z.enum(SESSION_OBSERVER_HEALTH_VALUES),
  planProgress: z
    .strictObject({
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .refine((value) => value.completed <= value.total)
    .optional(),
});

export function sanitizeSessionObserverModelText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(normalized, maxChars);
}

export function defaultReadSession(
  sessionKey: string,
  agentId: string,
  storePath?: string,
): Promise<SessionEntry | undefined> {
  // Read-only: observation must never materialize agent state (dirs, agent DB
  // registration) for agents that are not configured.
  return readSessionEntryReadOnlyInWorker({
    sessionKey,
    agentId,
    ...(storePath ? { storePath } : {}),
  });
}

export async function defaultPersistDigest(params: {
  target?: Parameters<typeof applySessionEntryTargetOperation>[0];
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  storePath?: string;
  digest: SessionObserverDigest;
  stillCurrent?: () => boolean;
}): Promise<boolean | null> {
  if (params.stillCurrent?.() === false) {
    return false;
  }
  // Rejected reducers return the existing row; only a commit receipt marks acceptance.
  let applied = false;
  const patchEntry = params.target
    ? applySessionEntryTargetOperation.bind(undefined, params.target)
    : applySessionEntryOperation.bind(undefined, {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      });
  const result = await patchEntry(
    { kind: "observer-digest", digest: params.digest, sessionId: params.sessionId },
    {
      preserveActivity: true,
      onCommitted: () => {
        applied = true;
        sessionChanges.emit({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          storePath: params.storePath,
          scope: "runtime",
          facts: { kind: "unchanged" },
        });
      },
    },
  );
  return result === null ? null : applied;
}

export async function synthesizeSessionObserverTerminalDigest(params: {
  source: { event?: AgentEventPayload; state?: SessionObserverState };
  dormant?: DormantSessionObserverRun;
  readSession: (
    sessionKey: string,
    agentId: string,
  ) => SessionEntry | undefined | Promise<SessionEntry | undefined>;
  persistDigest: NonNullable<SessionObserverDeps["persistDigest"]>;
  /** Rechecked at persist time: rollover can admit a newer run between the
   * synchronous synthesis start and the async write. */
  stillCurrent?: () => boolean;
}): Promise<SessionObserverDigest | undefined> {
  const runId = params.source.event?.runId ?? params.source.state?.runId;
  if (!runId) {
    return undefined;
  }
  const sessionKey =
    params.source.event?.sessionKey ??
    params.source.state?.sessionKey ??
    params.dormant?.sessionKey;
  const agentId =
    params.source.event?.agentId ?? params.source.state?.agentId ?? params.dormant?.agentId;
  const health = params.source.event
    ? terminalHealthFor(params.source.event)
    : params.source.state?.terminalHealth;
  if (!sessionKey || !agentId || !health) {
    return undefined;
  }
  const session = await params.readSession(sessionKey, agentId);
  if (params.stillCurrent?.() === false) {
    return undefined;
  }
  const lifecycle = params.source.state ?? params.dormant ?? session;
  if (
    !isSameSessionObserverLifecycle(lifecycle, session) ||
    (params.source.event?.sessionId !== undefined &&
      params.source.event.sessionId !== lifecycle?.sessionId)
  ) {
    return undefined;
  }
  const previous = [
    params.source.state?.previousDigest,
    params.dormant?.previousDigest,
    session?.observerDigest,
  ]
    .map((digest) => resolveSessionObserverDigestForLifecycle(digest, lifecycle))
    .find((digest) => digest?.runId === runId);
  if (!previous) {
    return undefined;
  }
  const sessionId = lifecycle?.sessionId;
  const terminalReply = params.source.event
    ? normalizeAgentRunTerminalReplySnapshot(params.source.event.data.terminalReply)
    : params.source.state?.terminalReply;
  const terminalHeadline =
    terminalReply?.disposition === "visible"
      ? sanitizeSessionObserverModelText(terminalReply.text, HEADLINE_MAX_CHARS)
      : undefined;
  const persistBounded = async (candidate: SessionObserverDigest): Promise<boolean> => {
    if (params.stillCurrent?.() === false) {
      return false;
    }
    return (
      (await params.persistDigest({
        sessionKey,
        sessionId,
        agentId,
        digest: candidate,
        stillCurrent: params.stillCurrent,
      })) === true
    );
  };
  if (previous.health === health) {
    // The live broadcast already matched the terminal health; only the durable
    // entry can lag behind the persist throttle. Catch it up without rebroadcast.
    if (previous.revision > (session?.observerDigest?.revision ?? 0)) {
      await persistBounded(previous);
    }
    return undefined;
  }
  const digest: SessionObserverDigest = {
    ...previous,
    sessionKey,
    agentId,
    runId,
    health,
    ...(terminalHeadline ? { headline: terminalHeadline } : {}),
    revision: previous.revision + 1,
    updatedAt: Date.now(),
  };
  // A rejected write (reset session, newer stored revision) must not surface
  // to watchers as a committed terminal status.
  return (await persistBounded(digest)) ? digest : undefined;
}

export function buildSessionObserverPrompt(
  state: Pick<SessionObserverState, "previousDigest" | "planProgress">,
  notes: readonly string[],
): string {
  const {
    sessionId: _sessionId,
    lifecycleRevision: _lifecycleRevision,
    ...previousDigest
  } = state.previousDigest ?? {};
  return JSON.stringify({
    previousDigest: state.previousDigest ? previousDigest : null,
    newNotes: notes,
    planProgress: state.planProgress ?? null,
  });
}

/** Validates strict model JSON and applies the protocol's hard string caps. */
export function normalizeSessionObserverModelOutput(text: string): {
  headline: string;
  assessment?: string;
  health: SessionObserverHealth;
  planProgress?: SessionObserverPlanProgress;
} | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const digest = safeParseJsonWithSchema(ModelDigestSchema, fenced?.[1]?.trim() ?? trimmed);
  if (!digest) {
    return null;
  }
  const headline = sanitizeSessionObserverModelText(digest.headline, HEADLINE_MAX_CHARS);
  const assessment = digest.assessment
    ? sanitizeSessionObserverModelText(digest.assessment, ASSESSMENT_MAX_CHARS)
    : undefined;
  if (!headline || (digest.assessment && !assessment)) {
    return null;
  }
  return {
    headline,
    ...(assessment ? { assessment } : {}),
    health: digest.health,
    ...(digest.planProgress ? { planProgress: digest.planProgress } : {}),
  };
}

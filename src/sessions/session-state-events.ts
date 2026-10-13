/** Best-effort durable signal log for session state changes. */
import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import {
  preparePhysicalSessionStorePath,
  prepareSessionWatcherStorePaths,
  type PreparedSessionWatcherStorePaths,
} from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import {
  captureSystemEventStoreCurrentCheck,
  prepareSystemEventStorePath,
} from "../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildAgentMainSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
  type SessionWatchCursorProvenance,
} from "../state/session-watch-cursor-provenance.js";
import { classifySessionKind } from "./classify-session-kind.js";
import type { InputProvenance } from "./input-provenance.js";
import type { SessionStateActorType } from "./session-state-event-kinds.js";
import { beginAmbientWatchPrune } from "./session-state-events.ambient-read.js";
import {
  getSessionStateKysely,
  isNotifiableWatcherKey,
  rowToSessionStateEvent,
  type SessionStateEventInput,
} from "./session-state-events.kernel.js";
import {
  runSessionWatchOperation,
  type SessionWatchOptions,
} from "./session-state-events.operation.js";
import { pruneSessionStateEvents } from "./session-state-events.prune.js";
import type { SessionStateReadOperations } from "./session-state-events.read.worker-contract.js";
import type { SessionStateEventRecord } from "./session-state-events.types.js";
import type {
  SessionStateWatchAddress,
  SessionStateWorkerOperations,
} from "./session-state-events.worker-contract.js";
import { acknowledgeSessionStateNoticesInWorker } from "./session-state-notice-acknowledgment.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

export { sweepSessionStateWatchNotices } from "./session-state-events.sweep.js";
export type { SessionStateActorType } from "./session-state-event-kinds.js";

const log = createSubsystemLogger("sessions/state-events");
/** Classify the actor once at producer boundaries; missing provenance is interactive human input. */
export function classifySessionStateActor(opts: {
  inputProvenance?: InputProvenance;
  internalEvents?: readonly unknown[];
  sessionEffects?: "visible" | "internal";
  humanActorId?: string;
}): { actorType: SessionStateActorType; actorId?: string } {
  if (opts.inputProvenance?.kind === "inter_session") {
    return {
      actorType: "agent",
      ...(opts.inputProvenance.sourceSessionKey
        ? { actorId: opts.inputProvenance.sourceSessionKey }
        : {}),
    };
  }
  if (
    opts.inputProvenance?.kind === "internal_system" ||
    (opts.internalEvents?.length ?? 0) > 0 ||
    opts.sessionEffects === "internal"
  ) {
    return { actorType: "system" };
  }
  return { actorType: "human", ...(opts.humanActorId ? { actorId: opts.humanActorId } : {}) };
}

/** Return the durable signal-log head for one session; degrades to 0 on read failure. */
export async function getSessionStateVersion(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<number> {
  return (
    (await getSessionStateVersions([{ sessionKey, agentId }], options))[agentId]?.[sessionKey] ?? 0
  );
}

/** Batch durable signal-log heads for session-list enrichment, keyed agent → session key. */
export async function getSessionStateVersions(
  refs: ReadonlyArray<{ sessionKey: string; agentId: string }>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<Record<string, Record<string, number>>> {
  if (refs.length === 0) {
    return {};
  }
  try {
    const context = captureOpenClawStateReadWorkerContext(options);
    const result = await executeExistingOpenClawStateRead(
      options,
      {
        type: "sessionState.versions",
        input: refs,
      },
      { context },
    );
    context.admission.assertCurrent();
    if (result && !result.ok) {
      throw new Error(result.message);
    }
    return result?.type === "sessionState.versions" ? result.versions : {};
  } catch (error) {
    log.warn(`failed to read session state versions: ${String(error)}`);
    return {};
  }
}

/** List retained signal-log events after a version without advancing watcher cursors. */
export async function listSessionStateEventsSince(
  sessionKey: string,
  agentId: string,
  afterSequence: number,
  limit = 200,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SessionStateReadOperations["sessionState.events"]["output"]["page"]> {
  try {
    const context = captureOpenClawStateReadWorkerContext(options);
    const result = await executeExistingOpenClawStateRead(
      options,
      {
        type: "sessionState.events",
        input: { sessionKey, agentId, afterSequence, limit },
      },
      { context },
    );
    context.admission.assertCurrent();
    if (result && !result.ok) {
      throw new Error(result.message);
    }
    if (result?.type === "sessionState.events") {
      return result.page;
    }
  } catch (error) {
    log.warn(`failed to list session state events: ${String(error)}`);
  }
  return { events: [], truncated: false, earliestAvailableSequence: 0, historyGap: false };
}

type PreparedSessionWatchCaller = Pick<
  SessionWatchOptions,
  "assertCurrent" | "sessionEntriesCurrent"
> & {
  release(): void;
};

type SessionWatchRegistrationOptions =
  | (SessionWatchOptions & { prepareCurrent?: undefined })
  | (Pick<SessionWatchOptions, "path" | "env" | "now"> & {
      prepareCurrent(): Promise<PreparedSessionWatchCaller>;
      assertCurrent?: never;
      sessionEntriesCurrent?: never;
    });

/** Ack only the frozen notice watermark; advancing to head would lose an interleaved event. */
export function acknowledgeSessionStateNotices(
  watcherSessionKey: string,
  notices: readonly SessionStateWatchAddress[],
  options: SessionWatchOptions = {},
): Promise<void> {
  return acknowledgeSessionStateNoticesInWorker(
    watcherSessionKey,
    notices,
    enqueueSessionStateNotice,
    options,
  );
}

/** Reset parent-side assumptions while retaining target history across session incarnations. */
export async function handleSessionStateSessionReset(
  sessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  try {
    await clearSessionState({ kind: "reset", sessionKey }, options);
  } catch (error) {
    log.warn(`failed to reset session state cursors: ${String(error)}`);
  }
}

/** Delete all signal-log and cursor state owned by a deleted session key. */
export async function handleSessionStateSessionDeleted(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  try {
    await clearSessionState({ kind: "delete", sessionKey, agentId }, options);
  } catch (error) {
    log.warn(`failed to delete session state history: ${String(error)}`);
  }
}

async function clearSessionState(
  input: SessionStateWorkerOperations["sessionState.cleanup"]["input"],
  options: OpenClawStateDatabaseOptions,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  // Reset/delete already committed; queued cleanup must immediately revoke old prompt reads.
  const finish = beginAmbientWatchPrune(context.admission.identity.key);
  try {
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "sessionState.cleanup", input }),
      {
        createAdmission: createSqliteWorkerWriteAdmission(
          () => context.admission.assertCurrent(),
          [context.admission.databasePath],
        ),
      },
    );
  } finally {
    finish();
  }
}

/** Record one successful compaction from the two concrete v1 owners. */
export function recordSessionCompacted(params: {
  sessionKey?: string;
  operationId: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
}): Promise<void> | undefined {
  if (!params.sessionKey) {
    return undefined;
  }
  // Native-harness-only compaction remains log-incomplete in v1; this signal is reconciliation aid.
  return recordSessionStateEventAsync({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "compacted",
    actorType: "system",
    runId: params.runId,
    dedupeKey: `compacted:${params.operationId}`,
    summary: "session compacted",
  }).then(() => {});
}

type AsyncSessionStateEventOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
  context?: OpenClawStateWorkerContext;
  now?: number;
  assertCurrent?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
  onlyIfWatched?: boolean;
  expectedUpstream?: SessionUpstreamLink;
  acpControl?: import("../acp/runtime/session-meta-control.types.js").AcpSessionControlConstraint;
};

/** Async producers settle the existing worker's event, notices, and bounded maintenance together. */
export async function recordSessionStateEventAsync(
  input: SessionStateEventInput,
  options: AsyncSessionStateEventOptions = {},
): Promise<SessionStateEventRecord | undefined> {
  const sessionEntryCurrent = options.sessionEntryCurrent;
  let watcherPaths: Promise<PromiseSettledResult<PreparedSessionWatcherStorePaths>[]> | undefined;
  try {
    const context = options.context ?? captureOpenClawStateWorkerContext(options);
    const now = options.now ?? Date.now();
    const event = structuredClone(input);
    const expectedUpstream = options.expectedUpstream && structuredClone(options.expectedUpstream);
    const acpControl = options.acpControl && structuredClone(options.acpControl);
    let preparedWatchers: PreparedSessionWatcherStorePaths | undefined;
    const assertCurrent = () => {
      options.assertCurrent?.();
      preparedWatchers?.assertCurrent();
    };
    if (!event.watcherStorePaths) {
      watcherPaths = Promise.allSettled([
        prepareSessionWatcherStorePaths(
          event.watcherSessionKeys,
          context.initializationEnvironment,
        ),
      ]);
    }
    const preparedPaths = watcherPaths;
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        if (preparedPaths) {
          const result = (await preparedPaths)[0]!;
          if (result.status === "rejected") {
            throw result.reason;
          }
          preparedWatchers = result.value;
          event.watcherStorePaths = preparedWatchers.paths;
        }
        const recorded = await scope.execute({
          type: "sessionState.record",
          input: {
            event,
            now,
            onlyIfWatched: options.onlyIfWatched,
            expectedUpstream,
            acpControl,
            sessionEntryCurrentSource: sessionEntryCurrent?.source,
          },
        });
        for (const notice of recorded.notices) {
          enqueueSessionStateNotice(notice);
        }
        if (recorded.row) {
          await pruneSessionStateEvents({
            context,
            now,
            execute: () =>
              scope.execute({
                type: "sessionState.prune",
                input: { now, sessionEntryCurrentSource: sessionEntryCurrent?.source },
              }),
          });
        }
        return recorded.row ? rowToSessionStateEvent(recorded.row) : undefined;
      },
      {
        assertCurrent,
        createAdmission: () => ({
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Session signal mutation requires transaction admission");
            }
            context.admission.assertCurrent();
            assertCurrent();
            assertSessionEntryCurrentAdmission(request, sessionEntryCurrent);
            grant();
          }),
        }),
      },
    );
  } catch (error) {
    // A committed originating action and an uncertain signal must never be replayed.
    try {
      log.warn(`failed to record session state event: ${String(error)}`);
    } catch {
      // Keep the originating durable result even when the diagnostic sink fails.
    }
    return undefined;
  } finally {
    // Preparation may already be admitted when the signal writer refuses opening.
    await watcherPaths;
  }
}

/** Record a persisted goal mutation using lineage already available at the session-store seam. */
export async function recordSessionGoalChanged(params: {
  sessionKey: string;
  entry: SessionEntry;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
  summary: string;
}): Promise<void> {
  const watcherSessionKey = params.entry.spawnedBy ?? params.entry.parentSessionKey;
  await recordSessionStateEventAsync({
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "goal_changed",
    actorType: params.actor?.type ?? "system",
    ...(params.actor?.id ? { actorId: params.actor.id } : {}),
    summary: params.summary,
    ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
  });
}

/** Released synchronous SDK compatibility; runtime prompt preparation uses worker reads. */
export function listAmbientGroupWatchTargets(
  watcherSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): Set<string> {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const rows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("target_session_key")
        .where("watcher_session_key", "=", watcherSessionKey)
        .where("provenance", "=", SESSION_WATCH_PROVENANCE_AMBIENT_GROUP),
    ).rows;
    return new Set(rows.map((row) => row.target_session_key));
  } catch (error) {
    log.warn(`failed to list ambient group watch targets: ${String(error)}`);
    return new Set();
  }
}

async function registerWatch(
  params: { watcherSessionKey: string; targetSessionKey: string; targetAgentId?: string },
  provenance: SessionWatchCursorProvenance,
  options: SessionWatchRegistrationOptions,
): Promise<boolean> {
  if (
    params.watcherSessionKey === params.targetSessionKey ||
    !isNotifiableWatcherKey(params.watcherSessionKey)
  ) {
    return false;
  }
  let prepared: PreparedSessionWatchCaller | undefined;
  try {
    const context = captureOpenClawStateWorkerContext(options);
    const isStoreCurrent = captureSystemEventStoreCurrentCheck(params.watcherSessionKey);
    const input = {
      ...params,
      targetAgentId: params.targetAgentId ?? resolveAgentIdFromSessionKey(params.targetSessionKey),
      provenance,
      now: options.now ?? Date.now(),
    };
    const watcherStorePath = await (prepareSystemEventStorePath(input.watcherSessionKey) ??
      preparePhysicalSessionStorePath({
        sessionKey: input.watcherSessionKey,
        env: context.initializationEnvironment,
      }));
    context.admission.assertCurrent();
    prepared = await options.prepareCurrent?.();
    const caller = prepared ?? options;
    context.admission.assertCurrent();
    const assertCurrent = () => {
      caller.assertCurrent?.();
      if (!isStoreCurrent(watcherStorePath)) {
        throw new Error("Session watch registration lost its system-event store");
      }
    };
    return await runSessionWatchOperation(
      context,
      async (scope) => {
        const registered = await scope.execute({
          type: "sessionState.registerWatch",
          input: {
            ...input,
            watcherStorePath,
            sessionEntryCurrentSources: caller.sessionEntriesCurrent?.sources,
          },
        });
        assertCurrent();
        return registered;
      },
      assertCurrent,
      caller.sessionEntriesCurrent,
    );
  } catch (error) {
    log.warn(`failed to register session state watch: ${String(error)}`);
    return false;
  } finally {
    prepared?.release();
  }
}

/** Register an explicit watcher (e.g. a sessions_send coordinator) for a target session. */
export function registerSessionStateWatch(
  params: { watcherSessionKey: string; targetSessionKey: string; targetAgentId?: string },
  options: SessionWatchRegistrationOptions = {},
): Promise<boolean> {
  return registerWatch(params, SESSION_WATCH_PROVENANCE_EXPLICIT, options);
}

/** Register the agent's main session to observe one routed group session. */
export async function registerMainSessionGroupWatch(
  params: {
    sessionKey: string;
    agentId: string;
    entry?: SessionEntry;
    mainKey?: string;
    isSystemEvent?: boolean;
    inputProvenance?: InputProvenance;
    signal?: AbortSignal;
  },
  options: SessionWatchOptions = {},
): Promise<boolean> {
  if (
    params.isSystemEvent ||
    classifySessionStateActor(params).actorType !== "human" ||
    classifySessionKind(params.sessionKey, params.entry) !== "group"
  ) {
    return false;
  }
  const watcherSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
  });
  // A group routed into main already shares its conversation; dmScope is orthogonal.
  return registerWatch(
    { watcherSessionKey, targetSessionKey: params.sessionKey, targetAgentId: params.agentId },
    SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
    {
      ...options,
      assertCurrent: () => {
        params.signal?.throwIfAborted();
        options.assertCurrent?.();
      },
    },
  );
}

export async function recordSessionHumanDirectMessage(
  params: {
    sessionKey: string;
    entry?: SessionEntry;
    agentId?: string;
    actor: { actorType: SessionStateActorType; actorId?: string };
    channel?: string;
    runId?: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
    occurredAt?: number;
  },
  options: AsyncSessionStateEventOptions = {},
): Promise<SessionStateEventRecord | undefined> {
  const watcherSessionKey = params.entry?.spawnedBy ?? params.entry?.parentSessionKey;
  if (params.actor.actorType !== "human") {
    return undefined;
  }
  return recordSessionStateEventAsync(
    {
      sessionKey: params.sessionKey,
      sessionId: params.entry?.sessionId,
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      kind: "human_direct_message",
      actorType: "human",
      ...(params.actor.actorId ? { actorId: params.actor.actorId } : {}),
      runId: params.runId,
      ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
      summary: `human message via ${params.channel?.trim() || "unknown"}`,
      payload: params.payload,
      ...(params.occurredAt === undefined ? {} : { occurredAt: params.occurredAt }),
      ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
    },
    { ...options, onlyIfWatched: !watcherSessionKey },
  );
}

/** Seed the parent cursor at the child-spawn version. */
export async function recordSubagentSpawned(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  agentId: string;
}): Promise<void> {
  await recordSessionStateEventAsync({
    sessionKey: params.childSessionKey,
    agentId: params.agentId,
    kind: "child_spawned",
    actorType: "agent",
    actorId: params.requesterSessionKey,
    runId: params.childRunId,
    dedupeKey: `child-spawned:${params.childRunId}`,
    summary: "child session spawned",
    watcherSessionKeys: [params.requesterSessionKey],
  });
}

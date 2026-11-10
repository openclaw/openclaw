import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import {
  listLiveSubagentRootSessions,
  resolveRootSubagentRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import {
  interruptOrphanedSessionPendingInputs,
  listOrphanedSessionPendingInputTargets,
} from "../config/sessions/session-pending-input-withdrawal.js";
import {
  derivePersistedSessionLifecyclePatch,
  restartResumeSkipReason,
} from "../config/sessions/session-run-lifecycle-projection.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import {
  activeSessionOperations,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { withAgentInputRecovery } from "../state/agent-database-preparation-context.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import type { ResumableQuestion } from "./question-manager.js";
import { resumeRestoredQuestion } from "./question-resume.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { recordRestartResumeFailure } from "./session-restart-resume-failure.js";
import { createRestartResumeSummary } from "./session-restart-resume-log.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue. Child runs do not resume independently. Inspect their saved work; send a fresh instruction to the same retained child session when appropriate. A stopped execution is not a yielded pause, and restarting it does not transfer workspace or publication ownership.";
const BACKGROUND_EXEC_STOPPED_TEXT =
  "Background exec processes were stopped; rerun them if still needed.";
// Old shutdown bumped updatedAt, but abandoned cycles can survive for weeks. Limit adoption
// to six hours before process start; longer stops lose this one-time upgrade resume.
// Remove this bridge once stable includes the graceful-restart redesign (#185730).
const LEGACY_RESTART_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

type SessionIdentity = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  hadBackgroundExec?: true;
  needsResume: boolean;
  questions?: ResumableQuestion[];
};

/**
 * Snapshot only live owners after admission closes, before shutdown aborts them. Pending
 * resumable questions ride on the same marker; a crash before this write loses them,
 * like the rest of the marker.
 */
export async function persistRunningSessionsForRestart(params: {
  cfg: OpenClawConfig;
  signal?: AbortSignal;
  questions?: ResumableQuestion[];
}): Promise<void> {
  const summary = createRestartResumeSummary("shutdown");
  const publish = () => summary.publish();
  params.signal?.addEventListener("abort", publish, { once: true });
  try {
    await persistRunningSessions(params, summary);
  } finally {
    params.signal?.removeEventListener("abort", publish);
    publish();
  }
}

async function persistRunningSessions(
  params: { cfg: OpenClawConfig; signal?: AbortSignal; questions?: ResumableQuestion[] },
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<void> {
  const assertCurrent = () => params.signal?.throwIfAborted();
  assertCurrent();
  const sessions = new Map<string, SessionIdentity>();
  const add = (input: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
    sessionId?: string;
    hadBackgroundExec?: true;
    needsResume?: boolean;
    question?: ResumableQuestion;
  }) => {
    const root = resolveRootSubagentRequester(input.sessionKey, input.agentId);
    const agentId =
      root.agentId ??
      parseAgentSessionKey(root.sessionKey)?.agentId ??
      resolveDefaultAgentId(params.cfg);
    const storePath =
      root.storePath ??
      (root.sessionKey === input.sessionKey ? input.storePath : undefined) ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const skip =
      restartResumeSkipReason(root.sessionKey) ??
      (resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId }) ? "incognito" : undefined);
    if (skip) {
      summary.record(agentId, root.sessionKey, skip);
      return;
    }
    const key = JSON.stringify([agentId, root.sessionKey]);
    let session = sessions.get(key);
    if (!session) {
      summary.record(agentId, root.sessionKey, "persistence-incomplete");
      session = {
        agentId,
        storePath,
        sessionKey: root.sessionKey,
        sessionId: root.sessionKey === input.sessionKey ? input.sessionId : undefined,
        hadBackgroundExec: input.hadBackgroundExec,
        needsResume: input.needsResume !== false,
      };
      sessions.set(key, session);
    } else {
      session.needsResume ||= input.needsResume !== false;
      if (input.hadBackgroundExec) {
        session.hadBackgroundExec = true;
      }
    }
    // Child sessions do not resume independently, so their questions are not carried.
    if (input.question && root.sessionKey === input.sessionKey) {
      (session.questions ??= []).push(input.question);
    }
  };
  for (const operation of activeSessionOperations()) {
    assertCurrent();
    if (operation.abortSignal.aborted) {
      summary.record(
        operation.agentId ??
          parseAgentSessionKey(operation.key)?.agentId ??
          resolveDefaultAgentId(params.cfg),
        operation.key,
        "already-aborted",
      );
      continue;
    }
    const target = getSessionControllerEntryForOperation(operation).target;
    add({
      sessionKey: operation.key,
      agentId: operation.agentId,
      sessionId: operation.sessionId,
      storePath: target?.physicalStorePath ?? target?.storeScope,
      // Completed replies can retain execution custody only to settle workspace uploads.
      needsResume: !operation.result && !hasCommittedReplyOperationOutcome(operation),
    });
  }
  for (const runId of listLiveAgentRunIds()) {
    assertCurrent();
    if (!hasAgentRunContextExecutionOwner(runId)) {
      continue;
    }
    const operation = findSessionControllerOperationByRunId(runId);
    if (operation && hasCommittedReplyOperationOutcome(operation)) {
      continue;
    }
    const run = getAgentRunContext(runId);
    if (run?.sessionKey) {
      add({ sessionKey: run.sessionKey, agentId: run.agentId, sessionId: run.sessionId });
    }
  }
  for (const root of listLiveSubagentRootSessions()) {
    assertCurrent();
    add(root);
  }
  for (const process of listRunningSessions()) {
    assertCurrent();
    const sessionKey = process.sessionKey ?? process.scopeKey;
    if (sessionKey) {
      add({ sessionKey, agentId: process.agentId, hadBackgroundExec: true });
    }
  }
  // Last, so a live run's session id wins; a question alone marks only its own session.
  for (const question of params.questions ?? []) {
    const { sessionKey, agentId } = question.record;
    if (sessionKey) {
      add({ sessionKey, agentId, sessionId: question.sessionId, needsResume: false, question });
    }
  }
  const selectors = new Map<string, SessionIdentity[]>();
  for (const session of sessions.values()) {
    const key = JSON.stringify([session.agentId, session.storePath]);
    const batch = selectors.get(key) ?? [];
    batch.push(session);
    selectors.set(key, batch);
  }
  // The replacement owner resolves each selector. Do not rediscover every store
  // before allowing the first marker write to commit.
  const writes = await Promise.allSettled(
    [...selectors.values()].map(async (batch) => {
      assertCurrent();
      const first = batch[0];
      if (!first) {
        return;
      }
      const selected = new Map(batch.map((session) => [session.sessionKey, session]));
      const preserveQueued = await applySessionEntryReplacements<
        Array<{ session: SessionIdentity; preserve: () => void }>
      >({
        agentId: first.agentId,
        storePath: first.storePath,
        sessionKeys: batch.map((session) => session.sessionKey),
        requireWriteSuccess: true,
        assertCommitAllowed: assertCurrent,
        update: async (entries) => {
          const replacements: Array<{ sessionKey: string; entry: InternalSessionEntry }> = [];
          const preserve: Array<{ session: SessionIdentity; preserve: () => void }> = [];
          for (const session of batch) {
            summary.record(session.agentId, session.sessionKey, "session-missing");
          }
          for (const { sessionKey, entry } of entries) {
            assertCurrent();
            const session = selected.get(sessionKey);
            if (!session) {
              continue;
            }
            const skip =
              restartResumeSkipReason(sessionKey, entry) ??
              (session.sessionId && session.sessionId !== entry.sessionId
                ? "session-changed"
                : undefined);
            summary.record(session.agentId, sessionKey, skip ?? "persistence-incomplete");
            if (skip) {
              continue;
            }
            const queued = await captureSessionQueuedInputsForRestart({
              ...session,
              storePath: first.storePath,
              sessionId: entry.sessionId,
            });
            const questions = session.questions
              ?.filter((question) => question.sessionId === entry.sessionId)
              .map((question) => question.record);
            if (!session.needsResume && queued.queuedInputIds.length === 0 && !questions?.length) {
              summary.record(session.agentId, sessionKey, "reply-completed");
              continue;
            }
            replacements.push({
              sessionKey,
              entry: {
                ...entry,
                resumeAfterRestart: {
                  queuedInputIds: queued.queuedInputIds,
                  ...(session.hadBackgroundExec ? { hadBackgroundExec: true } : {}),
                  ...(questions?.length ? { questions } : {}),
                },
              },
            });
            preserve.push({ session, preserve: queued.preserve });
          }
          return { result: preserve, replacements };
        },
      });
      for (const { session, preserve } of preserveQueued) {
        summary.record(session.agentId, session.sessionKey, "marked");
        preserve();
      }
    }),
  );
  throwIfSettledRejected(writes, "Restart marker persistence failed");
}

type RestartResumeParams = {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};

type RestartStoreTarget = {
  agentId: string;
  physicalAgentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};
type PreparedRestartStore = {
  target: RestartStoreTarget;
  entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
  orphaned: Awaited<ReturnType<typeof listOrphanedSessionPendingInputTargets>>;
};

// Initial discovery and deferred preparation share one operation per physical store.
// The Gateway lifetime owns the promises; completed stores must not rescan new inputs as orphans.
const restartRecovery = new WeakMap<
  object,
  {
    ready: Deferred;
    allowUnmarked: boolean;
    stores: Map<string, Promise<void>>;
  }
>();
function getRestartRecovery(context: GatewayRequestContext) {
  const owner = context.agentDatabaseStartup ?? context;
  let recovery = restartRecovery.get(owner);
  if (!recovery) {
    recovery = { ready: createDeferredCore(), allowUnmarked: true, stores: new Map() };
    restartRecovery.set(owner, recovery);
  }
  return recovery;
}

async function discoverRestartSessionStores(
  params: RestartResumeParams,
  env?: NodeJS.ProcessEnv,
): Promise<RestartStoreTarget[]> {
  const { context, signal } = params;
  signal.throwIfAborted();
  const cfg = context.getRuntimeConfig();
  const inventory = prepareSessionStoreTargetInventoryRead(
    prepareSessionStoreTargetInventory(
      cfg,
      listConfiguredSessionStoreAgentIds(cfg),
      env,
      "configured",
    ),
  );
  return inventory.withRead(
    async (snapshot) =>
      snapshot.agents.flatMap(({ reads }) =>
        reads.map(({ target, database }) => ({
          ...target,
          storePath: database.path,
          physicalAgentId: database.agentId,
          ...(env ? { env } : {}),
        })),
      ),
    () => signal.throwIfAborted(),
    signal,
  );
}

async function prepareRestartStore(
  params: RestartResumeParams,
  target: RestartStoreTarget,
): Promise<PreparedRestartStore | undefined> {
  const { signal, log } = params;
  const recovery = getRestartRecovery(params.context);
  let entries: PreparedRestartStore["entries"];
  try {
    entries = (await readSessionEntrySummariesInWorker(target)).filter(
      ({ entry }) => entry.resumeAfterRestart || entry.mainRestartRecovery || entry.lifecycleRunId,
    );
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    recovery.allowUnmarked = false;
    log.warn(`Skipped restart resume for agent ${target.agentId}: ${String(error)}`);
    return undefined;
  }
  let orphaned: PreparedRestartStore["orphaned"] = [];
  try {
    orphaned = await listOrphanedSessionPendingInputTargets(
      target,
      entries.flatMap(({ entry }) => entry.resumeAfterRestart?.queuedInputIds ?? []),
    );
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(`Skipped interrupted input settlement for agent ${target.agentId}: ${String(error)}`);
  }
  return { target, entries, orphaned };
}

function resumePreparedRestartStore(
  params: RestartResumeParams,
  prepared: PreparedRestartStore,
): Promise<void> {
  const recovery = getRestartRecovery(params.context);
  let work = recovery.stores.get(prepared.target.storePath);
  if (!work) {
    work = Promise.resolve().then(() =>
      withAgentInputRecovery(
        params.context.agentDatabaseStartup,
        prepared.target.physicalAgentId,
        () => resumeRestartStore(params, prepared),
      ),
    );
    recovery.stores.set(prepared.target.storePath, work);
  }
  return work;
}

/** Capture data during preparation; admit it only after the native borrow and startup prerequisites. */
export async function prepareAgentRestartRecovery(
  params: RestartResumeParams & {
    agentId: string;
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  },
): Promise<(() => Promise<void>) | undefined> {
  const prepared: PreparedRestartStore[] = [];
  for (const target of await discoverRestartSessionStores(params, params.env)) {
    if (target.physicalAgentId !== params.agentId) {
      continue;
    }
    params.assertCurrent();
    const store = await prepareRestartStore(params, target);
    params.assertCurrent();
    if (store && (store.entries.length || store.orphaned.length)) {
      prepared.push(store);
    }
  }
  if (!prepared.length) {
    return undefined;
  }
  // Do not retain assertCurrent: it belongs to the temporary preparation borrow.
  const { context, signal, log } = params;
  const ready = getRestartRecovery(context).ready.promise;
  return async () => {
    await racePromiseWithAbortSignal(ready, signal);
    await runWithGatewayIndependentRootWorkAdmission(
      () =>
        withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
          for (const store of prepared) {
            signal.throwIfAborted();
            await resumePreparedRestartStore({ context, signal, log }, store);
          }
        }),
      "startup:agent-session-resume",
      signal,
    );
  };
}

/** Recover markers and unfinished predecessor runs without reviving older orphans. */
export async function resumeMarkedSessions(params: RestartResumeParams): Promise<void> {
  const recovery = getRestartRecovery(params.context);
  const stores: PreparedRestartStore[] = [];
  let targets: RestartStoreTarget[];
  try {
    targets = await discoverRestartSessionStores(params);
    for (const target of targets) {
      params.signal.throwIfAborted();
      if (
        !recovery.stores.has(target.storePath) &&
        !params.context.agentDatabaseStartup?.isAgentInputRecoveryPending(target.physicalAgentId)
      ) {
        const prepared = await prepareRestartStore(params, target);
        if (prepared) {
          stores.push(prepared);
        }
      }
    }
    const { context, signal } = params;
    const preparation = context.agentDatabaseStartup;
    if (context.restartResumeWindow && recovery.allowUnmarked && preparation) {
      // Failed preparation prevents adoption; markers in other stores may represent
      // only a partial shutdown and do not dispose of this store's unfinished runs.
      const agentIds = listConfiguredSessionStoreAgentIds(context.getRuntimeConfig());
      const prepared = await Promise.allSettled(
        agentIds.flatMap(
          (agentId) => preparation.waitForAgentPreparation(agentId, { signal }) ?? [],
        ),
      );
      if (
        prepared.some((result) => result.status === "rejected") ||
        agentIds.some((agentId) => readAgentDatabaseAdmissionRefusal(agentId))
      ) {
        recovery.allowUnmarked = false;
      }
    }
  } catch (error) {
    recovery.allowUnmarked = false;
    throw error;
  } finally {
    // The startup observer reaches here only after deletion and subagent restoration.
    recovery.ready.resolve();
  }
  for (const store of stores) {
    await resumePreparedRestartStore(params, store);
  }
  // Prepared closures must own their FIFO slots before startup unlocks reconnecting sends.
  for (const target of targets) {
    await params.context.agentDatabaseStartup?.waitForAgentPreparation(target.physicalAgentId, {
      signal: params.signal,
      forInput: true,
    });
  }
  for (const work of recovery.stores.values()) {
    await work;
  }
}

async function resumeRestartStore(
  { context, signal, log }: RestartResumeParams,
  { target, entries, orphaned }: PreparedRestartStore,
): Promise<void> {
  const summary = createRestartResumeSummary("startup");
  for (const { sessionKey } of entries) {
    summary.record(
      parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
      sessionKey,
      "resume-incomplete",
    );
  }
  try {
    const processStartedAt = performance.timeOrigin;
    const window = context.restartResumeWindow;
    const recovery = getRestartRecovery(context);
    signal.throwIfAborted();
    for (const session of orphaned) {
      try {
        await interruptOrphanedSessionPendingInputs({ ...target, ...session }, () =>
          signal.throwIfAborted(),
        );
      } catch (error) {
        signal.throwIfAborted();
        log.warn(
          `Skipped interrupted input settlement for ${session.sessionKey}: ${String(error)}`,
        );
      }
    }
    for (const { sessionKey, entry: snapshotEntry } of entries) {
      let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>> | undefined;
      let interrupted = false;
      try {
        const resumed = await applySessionEntryReplacements<
          | {
              entry: InternalSessionEntry;
              marker: NonNullable<InternalSessionEntry["resumeAfterRestart"]>;
            }
          | undefined
        >({
          ...target,
          sessionKeys: [sessionKey],
          assertCommitAllowed: () => signal.throwIfAborted(),
          requireWriteSuccess: true,
          update: (current) => {
            const selected = current.find((row) => row.sessionKey === sessionKey)?.entry;
            if (!selected) {
              return { result: undefined };
            }
            const orphanedRun =
              selected.lifecycleRunId &&
              selected.lifecycleRunId === snapshotEntry.lifecycleRunId &&
              selected.status === undefined &&
              !restartResumeSkipReason(sessionKey, selected) &&
              !hasAgentRunContextExecutionOwner(selected.lifecycleRunId) &&
              (!selected.activeWriterRunId ||
                !hasAgentRunContextExecutionOwner(selected.activeWriterRunId));
            const marker: InternalSessionEntry["resumeAfterRestart"] =
              selected.resumeAfterRestart ??
              ((orphanedRun &&
                recovery.allowUnmarked &&
                window &&
                selected.startedAt !== undefined &&
                selected.startedAt >= window.startedAt &&
                selected.startedAt < window.endedAt) ||
              (selected.mainRestartRecovery &&
                selected.abortedLastRun === true &&
                selected.status === "interrupted" &&
                selected.updatedAt <= processStartedAt &&
                selected.updatedAt >= processStartedAt - LEGACY_RESTART_RESUME_WINDOW_MS)
                ? { queuedInputIds: [] }
                : undefined);
            if (!marker && !selected.mainRestartRecovery && !orphanedRun) {
              return { result: undefined };
            }
            const entry = {
              ...selected,
              resumeAfterRestart: undefined,
              mainRestartRecovery: undefined,
              ...(orphanedRun
                ? derivePersistedSessionLifecyclePatch({
                    entry: selected,
                    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
                    event: {
                      runId: selected.lifecycleRunId,
                      ts: Date.now(),
                      data: { phase: "end", aborted: true, stopReason: "restart" },
                    },
                  })
                : {}),
            };
            interrupted = Boolean(orphanedRun && !marker);
            return {
              result: marker ? { entry, marker } : undefined,
              replacements: [{ sessionKey, entry }],
            };
          },
        });
        if (!resumed) {
          summary.record(
            parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
            sessionKey,
            interrupted ? "orphaned-run-interrupted" : "marker-not-current-or-legacy-ineligible",
          );
          continue;
        }
        const { entry, marker } = resumed;
        const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
        const runId = snapshotEntry.lifecycleRunId ?? entry.lastRunId;
        let admissionStage = "principal";
        const skip = restartResumeSkipReason(sessionKey, entry);
        if (skip) {
          summary.record(agentId, sessionKey, skip);
          log.warn(
            `Skipped restart resume for ${sessionKey}: session is archived or has another execution owner`,
          );
          continue;
        }
        const session = { agentId, sessionKey, sessionId: entry.sessionId };
        // Each accepted sender retains its own admission even when the owner cannot resume.
        const continueQueuedInputs = () =>
          continueSessionQueuedInputs(
            context,
            { ...target, ...session },
            {
              signal,
              queuedInputIds: marker.queuedInputIds,
              assertCurrent: () => signal.throwIfAborted(),
            },
          );
        const restored = (marker.questions ?? []).filter((record) =>
          context.questionManager?.restore({ record, sessionId: entry.sessionId }, (outcome) => {
            void resumeRestoredQuestion(context, session, outcome);
          }),
        );
        if (restored.length > 0) {
          // The restored question's answer, skip, or expiry continues this session.
          summary.record(agentId, sessionKey, "awaiting-question");
          await continueQueuedInputs();
          continue;
        }
        try {
          authority = await prepareSessionSystemTurnAuthority({
            context,
            ...target,
            agentId,
            sessionKey,
            sessionId: entry.sessionId,
            preserveRecordedSource: true,
            assertCurrent: () => signal.throwIfAborted(),
          });
          admissionStage = "target";
          const captured = await captureSessionEventTargetForHost(agentId, sessionKey, {
            operatorAuthority: authority?.authority,
            assertCurrent: () => signal.throwIfAborted(),
          });
          if (captured.sessionId !== entry.sessionId) {
            throw new Error("Session changed before restart resume admission");
          }
          admissionStage = "session-event";
          const receipt = withPluginRuntimeGatewayContextResolver(
            context.resolveGatewayContext,
            () =>
              enqueueSessionEventForHost(
                marker.hadBackgroundExec
                  ? `${GATEWAY_RESTART_RESUME_TEXT} ${BACKGROUND_EXEC_STOPPED_TEXT}`
                  : GATEWAY_RESTART_RESUME_TEXT,
                {
                  agentId,
                  sessionKey,
                  source: "restart",
                  expectedTarget: captured,
                  abortSignal: signal,
                },
              ),
          );
          const retained = authority;
          authority = undefined;
          void receipt.settled
            .then((outcome) => {
              if (outcome.status === "failed") {
                log.warn(
                  `Restart resume input failed for ${sessionKey}: ${outcome.error ?? "unknown error"}`,
                );
              }
            })
            .finally(() => retained?.release())
            .catch((error: unknown) => {
              log.warn(`Restart resume input failed for ${sessionKey}: ${String(error)}`);
            });
          const accepted = await receipt.accepted;
          if (!accepted.ok) {
            throw accepted.cause ?? new Error(accepted.error);
          }
          summary.record(agentId, sessionKey, "resumed");
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          summary.record(agentId, sessionKey, "admission-failed");
          await recordRestartResumeFailure({
            target: { ...target, agentId, sessionKey },
            entry,
            runId,
            admissionStage,
            error,
            signal,
            log,
          });
        }
        await continueQueuedInputs();
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
      }
    }
  } finally {
    summary.publish();
  }
}

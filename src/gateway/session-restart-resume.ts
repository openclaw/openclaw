import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import {
  isMessageWaitingSubagentSession,
  listLiveSubagentRootSessions,
  listMessageWaitingSubagentSessions,
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
import {
  completeGatewayAgentRestartRecovery,
  type GatewayRestartResumeWindow,
} from "../infra/gateway-boot-lifecycle.js";
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
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import { withAgentInputRecovery } from "../state/agent-database-preparation-context.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
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
  parkedRunId?: string;
};

/** Snapshot only live owners after admission closes, before shutdown aborts them. */
export async function persistRunningSessionsForRestart(params: {
  cfg: OpenClawConfig;
  signal?: AbortSignal;
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
  params: { cfg: OpenClawConfig; signal?: AbortSignal },
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<void> {
  const assertCurrent = () => params.signal?.throwIfAborted();
  assertCurrent();
  const sessions = new Map<string, SessionIdentity>();
  const add = (input: Partial<SessionIdentity> & { sessionKey: string }) => {
    const root = input.parkedRunId
      ? input
      : resolveRootSubagentRequester(input.sessionKey, input.agentId);
    const agentId =
      root.agentId ??
      parseAgentSessionKey(root.sessionKey)?.agentId ??
      resolveDefaultAgentId(params.cfg);
    const storePath =
      root.storePath ??
      (root.sessionKey === input.sessionKey ? input.storePath : undefined) ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const skip =
      (resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId })
        ? "incognito"
        : undefined) ?? restartResumeSkipReason(root.sessionKey);
    if (skip && !(skip === "subagent" && input.parkedRunId)) {
      summary.record(agentId, root.sessionKey, skip);
      return;
    }
    const key = JSON.stringify([agentId, root.sessionKey]);
    const existing = sessions.get(key);
    if (!existing) {
      summary.record(agentId, root.sessionKey, "persistence-incomplete");
      sessions.set(key, {
        agentId,
        storePath,
        sessionKey: root.sessionKey,
        sessionId: root.sessionKey === input.sessionKey ? input.sessionId : undefined,
        hadBackgroundExec: input.hadBackgroundExec,
        needsResume: input.needsResume !== false,
        parkedRunId: input.parkedRunId,
      });
    } else {
      existing.needsResume ||= !input.parkedRunId && input.needsResume !== false;
      existing.hadBackgroundExec ||= input.hadBackgroundExec;
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
  for (const session of listMessageWaitingSubagentSessions()) {
    assertCurrent();
    add(session);
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
            const ownerSkip = restartResumeSkipReason(sessionKey, entry);
            const skip =
              (ownerSkip === "subagent" && session.parkedRunId ? undefined : ownerSkip) ??
              (session.sessionId && session.sessionId !== entry.sessionId
                ? "session-changed"
                : session.parkedRunId &&
                    !isMessageWaitingSubagentSession(sessionKey, entry, session.agentId)
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
            if (!session.needsResume && queued.queuedInputIds.length === 0) {
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
  windows?: GatewayRestartResumeWindow[];
  entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
  orphaned: Awaited<ReturnType<typeof listOrphanedSessionPendingInputTargets>>;
};

// Initial discovery and deferred preparation share one operation per physical agent.
// Completed agents must not rescan newly admitted inputs as orphans.
const restartRecovery = new WeakMap<
  object,
  {
    ready: Deferred;
    agents: Map<string, Promise<void>>;
  }
>();
function getRestartRecovery(context: GatewayRequestContext) {
  const owner = context.agentDatabaseStartup ?? context;
  let recovery = restartRecovery.get(owner);
  if (!recovery) {
    recovery = { ready: createDeferredCore(), agents: new Map() };
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
  let entries: PreparedRestartStore["entries"];
  try {
    entries = (await readSessionEntrySummariesInWorker(target)).filter(
      ({ entry }) => entry.resumeAfterRestart || entry.mainRestartRecovery || entry.lifecycleRunId,
    );
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(
      `Agent ${target.agentId} resume deferred: agent database unavailable: ${String(error)}`,
    );
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
  const windows = params.context.restartResumeWindows;
  return {
    target,
    entries,
    orphaned,
    windows:
      windows && Object.hasOwn(windows, target.physicalAgentId)
        ? windows[target.physicalAgentId]
        : undefined,
  };
}

async function prepareRestartStores(
  params: RestartResumeParams,
  targets: RestartStoreTarget[],
): Promise<PreparedRestartStore[] | undefined> {
  const prepared: PreparedRestartStore[] = [];
  for (const target of targets) {
    const store = await prepareRestartStore(params, target);
    if (!store) {
      return undefined;
    }
    prepared.push(store);
  }
  return prepared;
}

function resumePreparedRestartStores(
  params: RestartResumeParams,
  agentId: string,
  prepared: PreparedRestartStore[],
): Promise<void> {
  const recovery = getRestartRecovery(params.context);
  let work = recovery.agents.get(agentId);
  if (!work) {
    work = Promise.resolve().then(() =>
      withAgentInputRecovery(params.context.agentDatabaseStartup, agentId, async () => {
        let completed = true;
        for (const store of prepared) {
          completed = (await resumeRestartStore(params, store)) && completed;
        }
        const through = prepared[0]?.windows?.at(-1)?.endedAt;
        if (completed && through !== undefined) {
          params.signal.throwIfAborted();
          await completeGatewayAgentRestartRecovery(agentId, through, prepared[0]?.target.env);
        }
      }),
    );
    recovery.agents.set(agentId, work);
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
  const targets = (await discoverRestartSessionStores(params, params.env)).filter(
    (target) => target.physicalAgentId === params.agentId,
  );
  params.assertCurrent();
  const prepared = await prepareRestartStores(params, targets);
  params.assertCurrent();
  // Empty stores need the startup recovery barrier only to acknowledge pending crash windows.
  if (
    !prepared?.some(
      (store) => store.entries.length || store.orphaned.length || store.windows?.length,
    )
  ) {
    return undefined;
  }
  // Do not retain assertCurrent: it belongs to the temporary preparation borrow.
  const { context, signal, log, agentId } = params;
  const ready = getRestartRecovery(context).ready.promise;
  return async () => {
    await racePromiseWithAbortSignal(ready, signal);
    await runWithGatewayIndependentRootWorkAdmission(
      () =>
        withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
          signal.throwIfAborted();
          await resumePreparedRestartStores({ context, signal, log }, agentId, prepared);
        }),
      "startup:agent-session-resume",
      signal,
    );
  };
}

/** Recover markers and unfinished predecessor runs without reviving older orphans. */
export async function resumeMarkedSessions(params: RestartResumeParams): Promise<void> {
  const recovery = getRestartRecovery(params.context);
  const prepared = new Map<string, PreparedRestartStore[]>();
  const byAgent = new Map<string, RestartStoreTarget[]>();
  try {
    const targets = await discoverRestartSessionStores(params);
    for (const refusal of listAgentDatabaseAdmissionRefusals()) {
      params.log.warn(
        `Agent ${refusal.agentId} resume deferred: agent database unavailable (${refusal.code})`,
      );
    }
    for (const target of targets) {
      const stores = byAgent.get(target.physicalAgentId) ?? [];
      stores.push(target);
      byAgent.set(target.physicalAgentId, stores);
    }
    for (const [agentId, stores] of byAgent) {
      params.signal.throwIfAborted();
      if (
        !recovery.agents.has(agentId) &&
        !params.context.agentDatabaseStartup?.isAgentInputRecoveryPending(agentId)
      ) {
        const batch = await prepareRestartStores(params, stores);
        if (batch) {
          prepared.set(agentId, batch);
        }
      }
    }
  } finally {
    // The startup observer reaches here only after deletion and subagent restoration.
    recovery.ready.resolve();
  }
  for (const [agentId, stores] of prepared) {
    await resumePreparedRestartStores(params, agentId, stores);
  }
  // Prepared closures must own their FIFO slots before startup unlocks reconnecting sends.
  for (const agentId of byAgent.keys()) {
    await params.context.agentDatabaseStartup?.waitForAgentPreparation(agentId, {
      signal: params.signal,
      forInput: true,
    });
  }
  for (const work of recovery.agents.values()) {
    await work;
  }
}

async function resumeRestartStore(
  { context, signal, log }: RestartResumeParams,
  { target, entries, orphaned, windows }: PreparedRestartStore,
): Promise<boolean> {
  let completed = true;
  const summary = createRestartResumeSummary("startup");
  for (const { sessionKey } of entries) {
    summary.record(
      parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
      sessionKey,
      "resume-incomplete",
    );
  }
  try {
    signal.throwIfAborted();
    for (const session of orphaned) {
      try {
        await interruptOrphanedSessionPendingInputs({ ...target, ...session }, () =>
          signal.throwIfAborted(),
        );
      } catch (error) {
        signal.throwIfAborted();
        completed = false;
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
              parked: boolean;
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
            const parked = isMessageWaitingSubagentSession(sessionKey, selected, target.agentId);
            const orphanedRun =
              !parked &&
              selected.lifecycleRunId &&
              selected.lifecycleRunId === snapshotEntry.lifecycleRunId &&
              selected.status === undefined &&
              !restartResumeSkipReason(sessionKey, selected) &&
              !hasAgentRunContextExecutionOwner(selected.lifecycleRunId) &&
              (!selected.activeWriterRunId ||
                !hasAgentRunContextExecutionOwner(selected.activeWriterRunId));
            const marker: InternalSessionEntry["resumeAfterRestart"] =
              selected.resumeAfterRestart ??
              (parked ||
              (orphanedRun &&
                windows?.some(
                  (window) =>
                    selected.startedAt !== undefined &&
                    selected.startedAt >= window.startedAt &&
                    selected.startedAt < window.endedAt,
                )) ||
              (selected.mainRestartRecovery &&
                selected.abortedLastRun === true &&
                selected.status === "interrupted" &&
                selected.updatedAt <= performance.timeOrigin &&
                selected.updatedAt >= performance.timeOrigin - LEGACY_RESTART_RESUME_WINDOW_MS)
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
              result: marker ? { entry, marker, parked } : undefined,
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
        const { entry, marker, parked } = resumed;
        const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
        let admissionStage = "principal";
        const skip = restartResumeSkipReason(sessionKey, entry);
        if (skip && !(parked && skip === "subagent")) {
          summary.record(agentId, sessionKey, skip);
          log.warn(
            `Skipped restart resume for ${sessionKey}: session is archived or has another execution owner`,
          );
          continue;
        }
        if (parked) {
          // The registry retains the wait; a new requester message owns fresh admission.
          summary.record(agentId, sessionKey, "parked");
        } else {
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
              runId: snapshotEntry.lifecycleRunId ?? entry.lastRunId,
              admissionStage,
              error,
              signal,
              log,
            });
          }
        }
        // Each accepted sender retains its own admission even when the owner cannot resume.
        await continueSessionQueuedInputs(
          context,
          { ...target, agentId, sessionKey, sessionId: entry.sessionId },
          {
            signal,
            queuedInputIds: marker.queuedInputIds,
            assertCurrent: () => signal.throwIfAborted(),
          },
        );
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        completed = false;
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
      }
    }
  } finally {
    summary.publish();
  }
  return completed;
}

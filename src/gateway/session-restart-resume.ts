import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import {
  resolveSessionYieldWait,
  listLiveSubagentRootSessions,
  listYieldWaitingSessions,
  resolveRootSubagentRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryReplacements,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { interruptOrphanedSessionPendingInputs } from "../config/sessions/session-pending-input-withdrawal.js";
import {
  derivePersistedSessionLifecyclePatch,
  restartResumeSkipReason,
} from "../config/sessions/session-run-lifecycle-projection.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveSessionWorkStartBlock } from "../config/sessions/session-work-start.js";
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
import { completeGatewayAgentRestartRecovery } from "../infra/gateway-boot-lifecycle.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import {
  activeSessionOperations,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import {
  waitForAgentInputAdmission,
  withAgentInputRecovery,
} from "../state/agent-database-preparation-context.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  discoverRestartSessionStores,
  prepareRestartStores,
  type PreparedRestartStore,
  type RestartResumeParams,
  type RestartStoreTarget,
} from "./session-restart-resume-discovery.js";
import {
  acceptRestartResumeReceipt,
  recordRestartResumeFailure,
  recordRestartYieldFailure,
} from "./session-restart-resume-failure.js";
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
  parked?: boolean;
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
  params: Parameters<typeof persistRunningSessionsForRestart>[0],
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<void> {
  const assertCurrent = () => params.signal?.throwIfAborted();
  // Enumeration is synchronous; persistence checks custody again at the write boundary.
  assertCurrent();
  const sessions = new Map<string, SessionIdentity>();
  const add = (input: Partial<SessionIdentity> & { sessionKey: string }) => {
    const root = input.parked
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
    if (skip && !(skip === "subagent" && input.parked)) {
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
        parked: input.parked,
      });
    } else {
      existing.needsResume ||= !input.parked && input.needsResume !== false;
      existing.hadBackgroundExec ||= input.hadBackgroundExec;
    }
  };
  for (const operation of activeSessionOperations()) {
    const restartAborted = isAgentRunRestartAbortReason(operation.abortSignal.reason);
    if (operation.abortSignal.aborted && !restartAborted) {
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
      needsResume:
        (!operation.result || restartAborted) && !hasCommittedReplyOperationOutcome(operation),
    });
  }
  for (const runId of listLiveAgentRunIds()) {
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
    add(root);
  }
  for (const process of listRunningSessions()) {
    const sessionKey = process.sessionKey ?? process.scopeKey;
    if (sessionKey) {
      add({ sessionKey, agentId: process.agentId, hadBackgroundExec: true });
    }
  }
  for (const session of listYieldWaitingSessions()) {
    add(session);
  }
  const selectors = new Map<string, { first: SessionIdentity; batch: SessionIdentity[] }>();
  for (const session of sessions.values()) {
    const key = JSON.stringify([session.agentId, session.storePath]);
    const group = selectors.get(key) ?? { first: session, batch: [] };
    group.batch.push(session);
    selectors.set(key, group);
  }
  // The replacement owner resolves each selector. Do not rediscover every store
  // before allowing the first marker write to commit.
  const writes = await Promise.allSettled(
    [...selectors.values()].map(async ({ first, batch }) => {
      assertCurrent();
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
              (ownerSkip === "subagent" && session.parked ? undefined : ownerSkip) ??
              (session.sessionId && session.sessionId !== entry.sessionId
                ? "session-changed"
                : session.parked && !resolveSessionYieldWait(sessionKey, entry, session.agentId)
                  ? "session-changed"
                  : undefined);
            summary.record(session.agentId, sessionKey, skip ?? "persistence-incomplete");
            if (skip) {
              continue;
            }
            const queued = await captureSessionQueuedInputsForRestart({
              ...session,
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
                  queuedInputSources: queued.queuedInputSources,
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
) {
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
  return createPreparedRestartRecovery(params, params.agentId, prepared);
}

function createPreparedRestartRecovery(
  { context, signal, log }: RestartResumeParams,
  agentId: string,
  prepared: PreparedRestartStore[],
) {
  const sessions = new Map<string, Promise<void>>();
  for (const store of prepared) {
    for (const [key, ready] of store.sessions) {
      const earlier = sessions.get(key);
      sessions.set(
        key,
        earlier ? Promise.all([earlier, ready.promise]).then(() => {}) : ready.promise,
      );
    }
  }
  const ready = getRestartRecovery(context).ready.promise;
  return {
    sessions,
    run: async () => {
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
    },
  };
}

/** Recover markers and unfinished predecessor runs without reviving older orphans. */
export async function resumeMarkedSessions(
  params: RestartResumeParams & { onPrepared?: () => void },
): Promise<void> {
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
  const owner = params.context.agentDatabaseStartup;
  const pending = [...prepared].map(([agentId, stores]) => {
    const work = createPreparedRestartRecovery(params, agentId, stores);
    const completion = createDeferredCore();
    owner?.registerInputRecovery(agentId, {
      sessions: work.sessions,
      completion: completion.promise,
    });
    return () => work.run().finally(completion.resolve);
  });
  // Discovery installs per-session waits before reconnecting turns can reach admission.
  if (owner) {
    params.onPrepared?.();
  }
  throwIfSettledRejected(
    await Promise.allSettled(pending.map((run) => run())),
    "Restart recovery failed",
  );
  if (!owner) {
    params.onPrepared?.();
  }
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
  { target, entries, orphaned, windows, sessions }: PreparedRestartStore,
): Promise<boolean> {
  let completed = true;
  const assertRecoveryCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  const summary = createRestartResumeSummary("startup");
  const entryKeys = new Set(entries.map(({ sessionKey }) => sessionKey));
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
      } finally {
        if (!entryKeys.has(session.sessionKey)) {
          sessions.get(session.sessionKey)?.resolve();
        }
      }
    }
    for (const { sessionKey, entry: snapshotEntry } of entries) {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
      let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>> | undefined;
      let interrupted = false;
      try {
        await waitForAgentInputAdmission(agentId, {
          sessionKey,
          storePath: target.storePath,
          env: target.env,
          signal,
          owner: context.agentDatabaseStartup,
        });
        const resumed = await applySessionEntryReplacements<
          | {
              entry: InternalSessionEntry;
              marker: NonNullable<InternalSessionEntry["resumeAfterRestart"]>;
              parked: ReturnType<typeof resolveSessionYieldWait>;
              skip: ReturnType<typeof restartResumeSkipReason>;
            }
          | undefined
        >({
          ...target,
          sessionKeys: [sessionKey],
          assertCommitAllowed: assertRecoveryCurrent,
          requireWriteSuccess: true,
          update: (current) => {
            const selected = current.find((row) => row.sessionKey === sessionKey)?.entry;
            if (!selected) {
              return { result: undefined };
            }
            const parked = resolveSessionYieldWait(sessionKey, selected, agentId);
            const skip = restartResumeSkipReason(sessionKey, selected);
            const orphanedRun =
              (!parked || parked === "resume") &&
              selected.lifecycleRunId &&
              selected.lifecycleRunId === snapshotEntry.lifecycleRunId &&
              selected.status === undefined &&
              !skip &&
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
              // Keep durable custody until the new turn accepts, including another
              // restart while its workspace is still being prepared.
              resumeAfterRestart:
                (!parked || parked === "resume") && (!skip || (parked && skip === "subagent"))
                  ? marker
                  : undefined,
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
              result: marker ? { entry, marker, parked, skip } : undefined,
              replacements:
                orphanedRun ||
                selected.mainRestartRecovery ||
                entry.resumeAfterRestart !== selected.resumeAfterRestart
                  ? [{ sessionKey, entry }]
                  : undefined,
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
        const { entry, marker, parked, skip } = resumed;
        let admissionStage = "principal";
        if (skip && !(parked && skip === "subagent")) {
          summary.record(agentId, sessionKey, skip);
          log.warn(
            `Skipped restart resume for ${sessionKey}: session is archived or has another execution owner`,
          );
          continue;
        }
        if (parked === "unreachable") {
          await recordRestartYieldFailure({ sessionKey, agentId, entry, signal });
          summary.record(agentId, sessionKey, "yield-source-unavailable");
        } else if (parked === "waiting") {
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
            if (entry.pendingWorktree || entry.pendingProjectGitUrl !== undefined) {
              admissionStage = "workspace";
              const blocked = resolveSessionWorkStartBlock(sessionKey, entry, {
                allowPendingWorkspace: true,
              });
              if (blocked) {
                throw blocked;
              }
              const { prepareSessionWorkspaceForRun } =
                await import("./server-methods/session-create-project.js");
              // The previous turn's readiness scope died with the process. The
              // workspace owner rejoins preparation and publishes the ready binding.
              await prepareSessionWorkspaceForRun({
                entry,
                cfg: context.getRuntimeConfig(),
                agentId,
                sessionKey,
                storePath: target.storePath,
                context,
                signal,
                runId: randomUUID(),
                assertCurrent: composeSessionSourceAssertion(
                  [authority?.authority.assertCurrent],
                  (assertSources) => {
                    assertRecoveryCurrent();
                    assertSources();
                  },
                ),
                runSetupScript: authority?.authority.scopes.includes(ADMIN_SCOPE) === true,
              });
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
            const accepted = acceptRestartResumeReceipt(receipt, sessionKey, authority, log);
            authority = undefined;
            await accepted;
            summary.record(agentId, sessionKey, "resumed");
          } catch (error) {
            signal.throwIfAborted();
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
          await patchSessionEntryCore(
            { ...target, agentId, sessionKey },
            (current) =>
              current.sessionId === entry.sessionId &&
              current.lifecycleRevision === entry.lifecycleRevision
                ? { resumeAfterRestart: undefined }
                : null,
            {
              requireWriteSuccess: true,
              skipMaintenance: true,
              // Shutdown marks before cancelling recovery; its new marker wins.
              assertCommitAllowed: assertRecoveryCurrent,
            },
          );
        }
        // Each accepted sender retains its own admission even when the owner cannot resume.
        await continueSessionQueuedInputs(
          context,
          { ...target, agentId, sessionKey, sessionId: entry.sessionId },
          {
            ...marker,
            signal,
            assertCurrent: () => signal.throwIfAborted(),
          },
        );
      } catch (error) {
        signal.throwIfAborted();
        completed = false;
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
        sessions.get(sessionKey)?.resolve();
      }
    }
  } finally {
    summary.publish();
  }
  return completed;
}

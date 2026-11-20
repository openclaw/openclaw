import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionYieldWait } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import {
  applySessionEntryReplacements,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { createRestartResumeMarker } from "../config/sessions/session-restart-resume-scope.js";
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
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { completeGatewayAgentRestartRecovery } from "../infra/gateway-boot-lifecycle.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import {
  waitForAgentInputAdmission,
  withAgentInputRecovery,
} from "../state/agent-database-preparation-context.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  hasInterruptedCommittedRequesterSettleInput,
  prepareRestartCompletionCustody,
} from "./session-restart-resume-custody.js";
import {
  discoverRestartSessionStores,
  prepareRestartStores,
  resolveStartupRestartMarker,
  type PreparedRestartStore,
  type RestartResumeParams,
  type RestartStoreTarget,
} from "./session-restart-resume-discovery.js";
import {
  acceptRestartResumeReceipt,
  recordRestartResumeFailure,
  recordUnreachableYieldFailure,
} from "./session-restart-resume-failure.js";
import { createRestartResumeSummary } from "./session-restart-resume-log.js";
import { GATEWAY_RESTART_RESUME_TEXT } from "./session-restart-resume-prompt.js";
import {
  selectLiveRestartResumeSessions,
  type SessionIdentity,
} from "./session-restart-resume-selection.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

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
  // Snapshot live owners before ancestry reads; persistence checks custody again before writing.
  assertCurrent();
  const sessions = await selectLiveRestartResumeSessions(params.cfg, summary);
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
            preserve.push({ session, preserve: queued.preserve });
            if (!session.needsResume) {
              summary.record(
                session.agentId,
                sessionKey,
                session.scheduledAutomation ? "automation-owned" : "reply-completed",
              );
              continue;
            }
            replacements.push({
              sessionKey,
              entry: {
                ...entry,
                resumeAfterRestart: createRestartResumeMarker({
                  operatorSource:
                    session.operatorSource ?? entry.resumeAfterRestart?.operatorSource,
                }),
              },
            });
          }
          return { result: preserve, replacements };
        },
      });
      for (const { session, preserve } of preserveQueued) {
        if (session.needsResume) {
          summary.record(session.agentId, session.sessionKey, "marked");
        }
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
  deferred: Map<string, () => Promise<void>>,
): Promise<void> {
  const recovery = getRestartRecovery(params.context);
  let work = recovery.agents.get(agentId);
  if (!work) {
    work = Promise.resolve().then(() =>
      withAgentInputRecovery(params.context.agentDatabaseStartup, agentId, async () => {
        let completed = true;
        for (const store of prepared) {
          completed = (await resumeRestartStore(params, store, deferred)) && completed;
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
  const deferred = new Map<string, () => Promise<void>>();
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
    deferred,
    run: async () => {
      await racePromiseWithAbortSignal(ready, signal);
      await runWithGatewayIndependentRootWorkAdmission(
        () =>
          withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
            signal.throwIfAborted();
            await resumePreparedRestartStores(
              { context, signal, log },
              agentId,
              prepared,
              deferred,
            );
          }),
        "startup:agent-session-resume",
        signal,
      );
    },
  };
}

/** Recover markers and unfinished predecessor runs without reviving older orphans. */
export async function resumeMarkedSessions(
  params: RestartResumeParams & { onPrepared?: () => void | Promise<void> },
): Promise<void> {
  const owner = params.context.agentDatabaseStartup;
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
      if (!recovery.agents.has(agentId) && !owner?.isAgentInputRecoveryPending(agentId)) {
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
  const pending = [...prepared].map(([agentId, stores]) => {
    const work = createPreparedRestartRecovery(params, agentId, stores);
    const completion = createDeferredCore();
    owner?.registerInputRecovery(agentId, {
      sessions: work.sessions,
      deferred: work.deferred,
      completion: completion.promise,
    });
    return () => work.run().finally(completion.resolve);
  });
  // Discovery installs per-session waits before reconnecting turns can reach admission.
  if (owner) {
    await params.onPrepared?.();
  }
  throwIfSettledRejected(
    await Promise.allSettled(pending.map((run) => run())),
    "Restart recovery failed",
  );
  if (!owner) {
    await params.onPrepared?.();
  }
  for (const agentId of byAgent.keys()) {
    await owner?.waitForAgentPreparation(agentId, { signal: params.signal, forInput: true });
  }
  for (const work of recovery.agents.values()) {
    await work;
  }
}

async function resumeRestartStore(
  { context, signal, log }: RestartResumeParams,
  { target, entries, orphaned, outOfScope, windows, sessions }: PreparedRestartStore,
  deferred: Map<string, () => Promise<void>>,
): Promise<boolean> {
  let completed = true;
  const { assertCurrent: assertRecoveryCurrent, resume } = await prepareRestartCompletionCustody(
    { context, signal, log },
    { target, entries },
  );
  const summary = createRestartResumeSummary("startup");
  const queuedKeys = new Set(orphaned.map(({ sessionKey }) => sessionKey));
  const ended = new Set(outOfScope);
  for (const { sessionKey } of entries) {
    summary.record(
      parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
      sessionKey,
      "resume-incomplete",
    );
  }
  try {
    signal.throwIfAborted();
    for (const { sessionKey, entry: snapshotEntry } of entries) {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
      let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>> | undefined;
      let interrupted = false;
      let stale = false;
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
          update: async (current) => {
            const selected = current.find((row) => row.sessionKey === sessionKey)?.entry;
            if (!selected) {
              return { result: undefined };
            }
            const skip = restartResumeSkipReason(sessionKey, selected);
            let parked = resolveSessionYieldWait(sessionKey, selected, agentId);
            if (parked === "unreachable" && !skip) {
              parked = "resume";
            }
            if (
              parked &&
              (await hasInterruptedCommittedRequesterSettleInput(
                { ...target, agentId, sessionKey, sessionId: selected.sessionId },
                selected,
              ))
            ) {
              parked = undefined;
            }
            const sameRun = selected.lifecycleRunId === snapshotEntry.lifecycleRunId;
            const resolved = resolveStartupRestartMarker(selected, sameRun, {
              parked,
              skip,
              windows,
            });
            const { orphanedRun, marker } = resolved;
            stale = resolved.stale;
            if (!marker && !stale && !selected.mainRestartRecovery && !orphanedRun) {
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
                      runId: orphanedRun,
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
          if (stale) {
            ended.add(sessionKey);
            summary.record(agentId, sessionKey, "scope-changed");
            continue;
          }
          summary.record(
            agentId,
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
          await recordUnreachableYieldFailure({ sessionKey, agentId, entry, signal });
          summary.record(agentId, sessionKey, "yield-source-unavailable");
        } else if (parked === "waiting") {
          // The registry retains the wait; a new requester message owns fresh admission.
          summary.record(agentId, sessionKey, "parked");
          log.warn(
            `Parked restart resume (yield-waiting): ${truncateUtf16Safe(JSON.stringify({ agentId, sessionKey }), 1024)}`,
          );
        } else {
          try {
            authority = await prepareSessionSystemTurnAuthority({
              context,
              ...target,
              agentId,
              sessionKey,
              sessionId: entry.sessionId,
              preserveRecordedSource: true,
              operatorSource: marker.operatorSource,
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
                enqueueSessionEventForHost(GATEWAY_RESTART_RESUME_TEXT, {
                  agentId,
                  sessionKey,
                  source: "restart",
                  expectedTarget: captured,
                  abortSignal: signal,
                }),
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
              runId: snapshotEntry.activeWriterRunId ?? snapshotEntry.lifecycleRunId,
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
      } catch (error) {
        signal.throwIfAborted();
        completed = false;
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
        if (!queuedKeys.has(sessionKey)) {
          sessions.get(sessionKey)?.resolve();
        }
      }
    }
    for (const session of orphaned) {
      const agentId = parseAgentSessionKey(session.sessionKey)?.agentId ?? target.agentId;
      // Input queued behind work from another restart resume scope ended with it.
      const endCause = ended.has(session.sessionKey) ? "restart-unrecoverable" : undefined;
      try {
        const remaining = await continueSessionQueuedInputs(
          context,
          { ...target, ...session, agentId },
          { signal, assertCurrent: () => signal.throwIfAborted(), endCause },
        );
        if (remaining) {
          completed = false;
          deferred.set(session.sessionKey, async () => {
            await withAgentInputRecovery(
              context.agentDatabaseStartup,
              target.physicalAgentId,
              remaining.resume,
            );
            deferred.delete(session.sessionKey);
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        completed = false;
        log.warn(`Skipped queued input recovery for ${session.sessionKey}: ${String(error)}`);
      } finally {
        sessions.get(session.sessionKey)?.resolve();
      }
    }
  } finally {
    summary.publish();
  }
  // Admit restart inputs before recovered completion notices can start a turn.
  resume();
  return completed;
}

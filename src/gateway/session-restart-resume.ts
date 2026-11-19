import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import {
  listLiveSubagentRootSessions,
  listYieldWaitingSessions,
  resolveSessionYieldWait,
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
import { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import {
  interruptOrphanedSessionPendingInputs,
  listOrphanedSessionPendingInputTargets,
} from "../config/sessions/session-pending-input-withdrawal.js";
import { derivePersistedSessionLifecyclePatch } from "../config/sessions/session-run-lifecycle-projection.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import {
  captureSessionStoreEnvironment,
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "../config/sessions/session-store-target-inventory.js";
import {
  prepareSessionStoreTargetInventoryRead,
  withSessionStoreTarget,
} from "../config/sessions/session-store-target-runtime.js";
import { resolveSessionWorkStartBlock } from "../config/sessions/session-work-start.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import {
  activeSessionOperations,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { waitForAgentDatabaseWriteAdmission } from "../state/agent-database-preparation-context.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import {
  hasInterruptedCommittedRequesterSettleInput,
  prepareRestartCompletionCustody,
} from "./session-restart-resume-custody.js";
import { GATEWAY_RESTART_RESUME_TEXT } from "./session-restart-resume-prompt.js";
import type { RestartResumeParams } from "./session-restart-resume.types.js";
import { recordRestartYieldFailure } from "./session-restart-yield.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

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

function canResumeSession(
  sessionKey: string,
  entry: InternalSessionEntry,
  parked = false,
): boolean {
  return (
    !isCronSessionKey(sessionKey) &&
    !isAcpSessionKey(sessionKey) &&
    (parked || (!isSubagentSessionKey(sessionKey) && entry.createdVia !== "spawn")) &&
    !entry.acp &&
    !entry.modelSelectionLocked &&
    entry.archivedAt === undefined
  );
}

/** Snapshot only live owners after admission closes, before shutdown aborts them. */
export async function persistRunningSessionsForRestart(params: {
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<void> {
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
    parked?: boolean;
  }) => {
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
    if (
      isCronSessionKey(root.sessionKey) ||
      isAcpSessionKey(root.sessionKey) ||
      (isSubagentSessionKey(root.sessionKey) && !input.parked) ||
      resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId })
    ) {
      return;
    }
    const key = JSON.stringify([agentId, root.sessionKey]);
    const existing = sessions.get(key);
    if (!existing) {
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
      if (input.hadBackgroundExec) {
        existing.hadBackgroundExec = true;
      }
    }
  };
  for (const operation of activeSessionOperations()) {
    assertCurrent();
    if (operation.abortSignal.aborted) {
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
  for (const session of listYieldWaitingSessions()) {
    add(session);
  }
  const selectors = new Map<string, SessionIdentity[]>();
  for (const session of sessions.values()) {
    const key = JSON.stringify([session.agentId, session.storePath]);
    const batch = selectors.get(key) ?? [];
    batch.push(session);
    selectors.set(key, batch);
  }
  const stores = new Map<
    string,
    { agentId: string; storePath: string; sessions: SessionIdentity[] }
  >();
  const { env } = captureSessionStoreEnvironment(params.cfg);
  for (const batch of selectors.values()) {
    assertCurrent();
    const first = batch[0];
    if (!first) {
      continue;
    }
    const database = await withSessionStoreTarget(
      {
        agentId: first.agentId,
        storePath: first.storePath,
        env,
        candidates: captureSessionStoreReadCandidates(first.storePath),
      },
      async (target) => target.database,
      assertCurrent,
    );
    const store = stores.get(database.path) ?? {
      agentId: database.agentId,
      storePath: database.path,
      sessions: [],
    };
    store.sessions.push(...batch);
    stores.set(database.path, store);
  }
  // A crash/SIGKILL writes no markers. That intentionally lossy case needs a fresh user input.
  for (const store of stores.values()) {
    assertCurrent();
    const batch = store.sessions;
    const selected = new Map(batch.map((session) => [session.sessionKey, session]));
    const preserveQueued = await applySessionEntryReplacements<Array<() => void>>({
      agentId: store.agentId,
      storePath: store.storePath,
      sessionKeys: batch.map((session) => session.sessionKey),
      requireWriteSuccess: true,
      assertCommitAllowed: assertCurrent,
      update: async (entries) => {
        const replacements: Array<{ sessionKey: string; entry: InternalSessionEntry }> = [];
        const preserve: Array<() => void> = [];
        for (const { sessionKey, entry } of entries) {
          assertCurrent();
          const session = selected.get(sessionKey);
          if (
            !session ||
            !canResumeSession(sessionKey, entry, session.parked) ||
            (session.parked && !resolveSessionYieldWait(sessionKey, entry, session.agentId)) ||
            (session.sessionId && session.sessionId !== entry.sessionId)
          ) {
            continue;
          }
          const queued = await captureSessionQueuedInputsForRestart({
            ...session,
            storePath: store.storePath,
            sessionId: entry.sessionId,
          });
          if (!session.needsResume && queued.queuedInputIds.length === 0) {
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
          preserve.push(queued.preserve);
        }
        return { result: preserve, replacements };
      },
    });
    for (const preserve of preserveQueued) {
      preserve();
    }
  }
}

/** Admit one ordinary input per marker without holding healthy agents behind preparation. */
export async function resumeMarkedSessions(params: RestartResumeParams): Promise<void> {
  const { context, signal, log } = params;
  const startup = getAgentDatabaseStartupAdmission();
  const visited = new Set<string>();
  const readyAgents: string[] = [];
  for (const agentId of listConfiguredSessionStoreAgentIds(context.getRuntimeConfig())) {
    const prepared = startup?.waitForAgentPreparation(agentId, { forWrite: true, signal });
    if (!prepared || !startup) {
      readyAgents.push(agentId);
      continue;
    }
    // The initial inventory excludes preparing stores. Keep their recovery with the
    // same startup owner, rather than silently losing it when admission completes.
    startup.track(
      prepared
        .then(() =>
          runWithGatewayIndependentRootWorkAdmission(
            () => resumeAgentSessions(params, [agentId], visited),
            "startup:deferred-session-resume",
            signal,
          ),
        )
        .catch((error: unknown) => {
          if (!signal.aborted) {
            log.warn(`Deferred restart resume failed for agent ${agentId}: ${String(error)}`);
          }
        }),
    );
  }
  await resumeAgentSessions(params, readyAgents, visited);
}

async function resumeAgentSessions(
  params: RestartResumeParams,
  agentIds: readonly string[],
  visited: Set<string>,
): Promise<void> {
  const { context, signal, log } = params;
  const assertRecoveryCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  const processStartedAt = performance.timeOrigin;
  const cfg = context.getRuntimeConfig();
  const configuredAgents = new Set(listConfiguredSessionStoreAgentIds(cfg));
  const inventoryRequest = prepareSessionStoreTargetInventory(
    cfg,
    agentIds.filter((agentId) => configuredAgents.has(agentId)),
    undefined,
    "configured",
  );
  const inventory = prepareSessionStoreTargetInventoryRead(inventoryRequest);
  const targets = await inventory.withRead(
    async (snapshot) =>
      snapshot.agents.flatMap(({ reads }) =>
        reads.map(({ target, database }) => ({
          ...target,
          storePath: database.path,
          env: inventoryRequest.env,
        })),
      ),
    () => signal.throwIfAborted(),
    signal,
  );
  for (const target of targets) {
    const targetKey = target.storePath;
    if (visited.has(targetKey)) {
      continue;
    }
    visited.add(targetKey);
    signal.throwIfAborted();
    let entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
    try {
      entries = await readSessionEntrySummariesInWorker(target);
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Skipped restart resume for agent ${target.agentId}: ${String(error)}`);
      continue;
    }
    const completion = await prepareRestartCompletionCustody(params, { target, entries });
    try {
      const orphaned = await listOrphanedSessionPendingInputTargets(
        target,
        entries.flatMap(({ entry }) => entry.resumeAfterRestart?.queuedInputIds ?? []),
      );
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
    } catch (error) {
      signal.throwIfAborted();
      log.warn(
        `Skipped interrupted input settlement for agent ${target.agentId}: ${String(error)}`,
      );
    }
    for (const { sessionKey, entry: marked } of entries) {
      const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
      if (
        !marked.resumeAfterRestart &&
        !marked.mainRestartRecovery &&
        !resolveSessionYieldWait(sessionKey, marked, agentId)
      ) {
        continue;
      }
      let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>> | undefined;
      try {
        await waitForAgentDatabaseWriteAdmission(agentId, {
          env: target.env,
          signal,
          owner: getAgentDatabaseStartupAdmission(),
        });
        const resumed = await applySessionEntryReplacements<
          | {
              entry: InternalSessionEntry;
              marker: NonNullable<InternalSessionEntry["resumeAfterRestart"]>;
              parked: ReturnType<typeof resolveSessionYieldWait>;
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
            const parked = (await hasInterruptedCommittedRequesterSettleInput(
              { ...target, agentId, sessionKey, sessionId: selected.sessionId },
              selected,
            ))
              ? undefined
              : resolveSessionYieldWait(sessionKey, selected, agentId);
            // Markerless waiting rows already retain their durable continuation.
            // Do not manufacture a write that changes their activity timestamp.
            if (
              parked === "waiting" &&
              !selected.resumeAfterRestart &&
              !selected.mainRestartRecovery
            ) {
              return { result: undefined };
            }
            if (!parked && !selected.resumeAfterRestart && !selected.mainRestartRecovery) {
              return { result: undefined };
            }
            const marker: InternalSessionEntry["resumeAfterRestart"] =
              selected.resumeAfterRestart ??
              (parked ? { queuedInputIds: [] } : undefined) ??
              (selected.mainRestartRecovery &&
              selected.abortedLastRun === true &&
              selected.status === "interrupted" &&
              selected.updatedAt <= processStartedAt &&
              selected.updatedAt >= processStartedAt - LEGACY_RESTART_RESUME_WINDOW_MS
                ? { queuedInputIds: [] }
                : undefined);
            const entry = {
              ...selected,
              ...(parked === "resume"
                ? derivePersistedSessionLifecyclePatch({
                    entry: selected,
                    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
                    event: {
                      runId: selected.lifecycleRunId!,
                      ts: Date.now(),
                      data: { phase: "end", aborted: true, stopReason: "restart" },
                    },
                  })
                : {}),
              // Retain durable custody until admission, including another restart
              // while the workspace owner is still preparing the binding.
              resumeAfterRestart: canResumeSession(sessionKey, selected, Boolean(parked))
                ? marker
                : undefined,
              mainRestartRecovery: undefined,
            };
            return {
              result: marker ? { entry, marker, parked } : undefined,
              replacements:
                parked === "resume" ||
                selected.mainRestartRecovery ||
                entry.resumeAfterRestart !== selected.resumeAfterRestart
                  ? [{ sessionKey, entry }]
                  : undefined,
            };
          },
        });
        if (!resumed) {
          continue;
        }
        const { entry, marker, parked } = resumed;
        if (!canResumeSession(sessionKey, entry, Boolean(parked))) {
          log.warn(
            `Skipped restart resume for ${sessionKey}: session is archived or has another execution owner`,
          );
          continue;
        }
        if (parked === "unreachable") {
          await recordRestartYieldFailure({ sessionKey, agentId, entry, signal });
        } else if (parked !== "waiting") {
          try {
            authority = await prepareSessionSystemTurnAuthority({
              context,
              ...target,
              agentId,
              sessionKey,
              sessionId: entry.sessionId,
              assertCurrent: () => signal.throwIfAborted(),
            });
            const captured = await captureSessionEventTargetForHost(agentId, sessionKey, {
              operatorAuthority: authority?.authority,
              assertCurrent: () => signal.throwIfAborted(),
            });
            if (captured.sessionId !== entry.sessionId) {
              throw new Error("Session changed before restart resume admission");
            }
            if (entry.pendingWorktree || entry.pendingProjectGitUrl !== undefined) {
              const blocked = resolveSessionWorkStartBlock(sessionKey, entry, {
                allowPendingWorkspace: true,
              });
              if (blocked) {
                throw blocked;
              }
              const { prepareSessionWorkspaceForRun } =
                await import("./server-methods/session-create-project.js");
              // The old readiness scope died with the process. Rejoin its owner,
              // which publishes the prepared workspace under current authority.
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
              throw new Error(accepted.error);
            }
          } catch (error) {
            signal.throwIfAborted();
            log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
          }
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
            // Shutdown captures a new marker before cancelling recovery; it wins.
            assertCommitAllowed: assertRecoveryCurrent,
          },
        );
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
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
      }
    }
    completion.resume();
  }
}

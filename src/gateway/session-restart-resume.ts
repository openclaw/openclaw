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
  captureSessionStoreEnvironment,
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "../config/sessions/session-store-target-inventory.js";
import {
  prepareSessionStoreTargetInventoryRead,
  withSessionStoreTarget,
} from "../config/sessions/session-store-target-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
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
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

const GATEWAY_RESTART_RESUME_TEXT =
  "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue.";
const BACKGROUND_EXEC_STOPPED_TEXT =
  "Background exec processes were stopped; rerun them if still needed.";

type SessionIdentity = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  hadBackgroundExec?: true;
  needsResume: boolean;
};

function canResumeSession(sessionKey: string, entry: InternalSessionEntry): boolean {
  return (
    !isCronSessionKey(sessionKey) &&
    !isAcpSessionKey(sessionKey) &&
    !isSubagentSessionKey(sessionKey) &&
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
    if (
      isCronSessionKey(root.sessionKey) ||
      isAcpSessionKey(root.sessionKey) ||
      isSubagentSessionKey(root.sessionKey) ||
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
      });
    } else {
      existing.needsResume ||= input.needsResume !== false;
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
            !canResumeSession(sessionKey, entry) ||
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

type RestartResumeParams = {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};

async function* discoverRestartSessionStores({
  context,
  signal: lifetime,
  log,
}: RestartResumeParams) {
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetime, controller.signal]);
  const pending = new Set<Promise<void>>();
  const visited = new Set<string>();
  let needsDiscovery = true;
  try {
    for (const agentId of listConfiguredSessionStoreAgentIds(context.getRuntimeConfig())) {
      // Observe startup's completion, not a request timeout or its temporary write borrow.
      // Advisory maintenance follows this completion and must not delay retained inputs.
      const preparation = context.agentDatabaseStartup?.waitForAgentPreparation(agentId, {
        signal,
      });
      if (!preparation) {
        continue;
      }
      const waiting = preparation
        .catch((error: unknown) => {
          if (!signal.aborted) {
            log.warn(`Skipped restart resume for agent ${agentId}: ${String(error)}`);
          }
        })
        .finally(() => {
          pending.delete(waiting);
          needsDiscovery = true;
        });
      pending.add(waiting);
    }
    while (needsDiscovery || pending.size > 0) {
      signal.throwIfAborted();
      needsDiscovery = false;
      const cfg = context.getRuntimeConfig();
      const inventory = prepareSessionStoreTargetInventoryRead(
        prepareSessionStoreTargetInventory(
          cfg,
          listConfiguredSessionStoreAgentIds(cfg),
          undefined,
          "configured",
        ),
      );
      const targets = await inventory.withRead(
        async (snapshot) =>
          snapshot.agents.flatMap(({ reads }) =>
            reads.map(({ target, database }) => ({ ...target, storePath: database.path })),
          ),
        () => signal.throwIfAborted(),
        signal,
      );
      // Ready stores progress immediately; readiness changes during this scan schedule another.
      for (const target of targets) {
        if (!visited.has(target.storePath)) {
          visited.add(target.storePath);
          yield target;
        }
      }
      if (!needsDiscovery && pending.size > 0) {
        await Promise.race(pending);
      }
    }
  } finally {
    controller.abort();
    await Promise.all(pending);
  }
}

/** Admit one ordinary input per marker; startup does not wait for the agent to finish. */
export async function resumeMarkedSessions(params: RestartResumeParams): Promise<void> {
  const { context, signal, log } = params;
  for await (const target of discoverRestartSessionStores(params)) {
    signal.throwIfAborted();
    let entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
    try {
      entries = await readSessionEntrySummariesInWorker(target);
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Skipped restart resume for agent ${target.agentId}: ${String(error)}`);
      continue;
    }
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
      if (!marked.resumeAfterRestart) {
        continue;
      }
      let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>> | undefined;
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
            if (!selected?.resumeAfterRestart) {
              return { result: undefined };
            }
            const marker = selected.resumeAfterRestart;
            const entry = { ...selected, resumeAfterRestart: undefined };
            return {
              result: { entry, marker },
              replacements: [{ sessionKey, entry }],
            };
          },
        });
        if (!resumed) {
          continue;
        }
        const { entry, marker } = resumed;
        const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId;
        if (!canResumeSession(sessionKey, entry)) {
          log.warn(
            `Skipped restart resume for ${sessionKey}: session is archived or has another execution owner`,
          );
          continue;
        }
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
          if (signal.aborted) {
            throw error;
          }
          log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
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
        log.warn(`Skipped restart resume for ${sessionKey}: ${String(error)}`);
      } finally {
        authority?.release();
      }
    }
  }
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-api.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
import { prepareEmbeddedAgentRunAbort } from "../../agents/embedded-agent-runner/runs.abort-target.js";
import { killAllControlledSubagentRuns } from "../../agents/subagents/registry/subagent-control.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  type SessionAbortTargetContext,
  type SessionAbortTargetIdentity,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import {
  type AbortCutoff,
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
} from "./abort-cutoff.js";
import { setAbortMemory } from "./abort-primitives.js";
import type { FastAbortRequestParams, FastAbortResult, PreparedFastAbortRequest } from "./abort.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { prepareSessionLifecycleQueueCleanup } from "./queue/cleanup.js";
import { resolveReplyOperationsForSession } from "./reply-run-registry.js";
import { resolveSessionConversationBindingContext } from "./session-conversation-binding.js";

export function prepareSessionRunTargetAbort(params: {
  agentId: string;
  key?: string;
  sessionId?: string;
}): () => { active: boolean; aborted: boolean; retirement?: Promise<void> } {
  const key = normalizeOptionalString(params.key);
  const operations = resolveReplyOperationsForSession({
    ...params,
    sessionKeys: key ? [key] : [],
  });
  const sessionIds = new Set(operations.map((operation) => operation.sessionId));
  const explicitSessionId = normalizeOptionalString(params.sessionId);
  const commands =
    key || explicitSessionId
      ? captureExecRequestCancellation({
          sessionKey: key,
          sessionId: explicitSessionId,
          agentId: params.agentId,
        })
      : undefined;
  if (explicitSessionId) {
    sessionIds.add(explicitSessionId);
  }
  if (key) {
    const activeSessionId = resolveActiveEmbeddedRunSessionId(key);
    if (
      activeSessionId &&
      (sessionIds.has(activeSessionId) ||
        parseAgentSessionKey(key)?.agentId === normalizeAgentId(params.agentId))
    ) {
      sessionIds.add(activeSessionId);
    }
  }

  const runs = [...sessionIds].map(prepareEmbeddedAgentRunAbort);
  return () => {
    let active = operations.some((operation) => !operation.result);
    const failures: unknown[] = [];
    let aborted = commands?.cancel() === true;
    for (const operation of operations) {
      for (const sessionId of operation.captureOwnedSessionIds()) {
        sessionIds.add(sessionId);
      }
      try {
        aborted = operation.abortByUser() || aborted;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const run of runs) {
      try {
        const outcome = run();
        active ||= outcome.active;
        aborted ||= outcome.aborted;
        if (outcome.sessionId) {
          sessionIds.add(outcome.sessionId);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    // Stop owns these captured IDs; a later turn may rebind the session key.
    // Join command cleanup even when another cancellation or retirement fails.
    const retirement =
      !active || aborted || failures.length > 0
        ? Promise.allSettled([
            ...[...sessionIds].map((sessionId) =>
              retireSessionMcpRuntime({
                sessionId,
                reason: "session-stop",
                preserveActiveLeases: true,
              }),
            ),
            commands?.settle(),
          ]).then((results) => {
            for (const result of results) {
              if (result.status === "rejected") {
                failures.push(result.reason);
              }
            }
            if (failures.length === 1) {
              throw failures[0];
            }
            if (failures.length > 1) {
              throw new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
            }
          })
        : undefined;
    return { active, aborted, retirement };
  };
}

function resolveStoredSessionId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): string | undefined {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  try {
    return loadSessionEntry({
      agentId: params.agentId,
      clone: false,
      sessionKey: params.sessionKey,
      storePath,
    })?.sessionId;
  } catch {
    return undefined;
  }
}

async function resolveBoundAcpAbortTargetSessionKey(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  activeSessionKey: string;
}): Promise<string | undefined> {
  const bindingContext = resolveSessionConversationBindingContext(params.cfg, params.ctx);
  if (!bindingContext) {
    return undefined;
  }
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    ...bindingContext,
    activeSessionKey: params.activeSessionKey,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

export async function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}): Promise<{ stopped: number; failed: number }> {
  const cleaned = normalizeOptionalString(params.requesterSessionKey);
  if (!cleaned) {
    await params.beforeKill?.();
    return { stopped: 0, failed: 0 };
  }
  const { alias } = resolveMainSessionAlias(params.cfg);
  const requesterKey = resolveInternalSessionKey({ key: cleaned, alias });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: requesterKey,
    fallbackAgentId: params.requesterAgentId,
  });
  const result = await killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller: {
      controllerSessionKey: requesterKey,
      controllerAgentId,
      callerSessionKey: requesterKey,
      callerIsSubagent: isSubagentSessionKey(requesterKey),
      controlScope: "children",
    },
    runs: listRunsForControllerFromRuns(subagentRuns, requesterKey),
    suppressTaskDelivery: true,
    beforeKill: params.beforeKill,
  });
  if (result.status === "error") {
    logVerbose(`abort: failed to stop subagents for ${requesterKey}: ${result.error}`);
  }
  if (result.killed > 0) {
    logVerbose(`abort: stopped ${result.killed} subagent run(s) for ${requesterKey}`);
  }
  return { stopped: result.killed, failed: result.status === "error" ? result.failed : 0 };
}

export async function executeFastAbortRequest(
  params: FastAbortRequestParams,
  request: PreparedFastAbortRequest,
): Promise<FastAbortResult> {
  const { ctx, cfg } = params;
  const { commandSessionKey, targetKey, resolveTargetAgentId } = request;

  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: ctx.CommandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }

  const agentId = resolveTargetAgentId();
  const abortKey = targetKey ?? auth.from ?? auth.to;
  const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;

  if (targetKey) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const abortCutoffForTarget = (target: SessionAbortTargetContext): AbortCutoff | undefined =>
      shouldPersistAbortCutoff({
        commandSessionKey,
        targetSessionKey: target.sessionKey,
      })
        ? resolveAbortCutoffFromContext(ctx)
        : undefined;
    let resolvedAbortTarget: SessionAbortTargetIdentity | null = null;
    try {
      resolvedAbortTarget = resolveSessionAbortTarget({
        agentId,
        sessionKey: targetKey,
        storePath,
      });
    } catch (error) {
      logVerbose(
        `abort: failed to resolve abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
    }
    const resolvedTargetKey = resolvedAbortTarget?.sessionKey ?? targetKey;
    const assertCurrent = () => {
      if (params.isCommandTargetCurrent?.() === false) {
        throw new Error("The selected session changed before it could be stopped.");
      }
    };
    const prepareTarget = (key: string) => {
      const targetAgentId =
        key === resolvedTargetKey
          ? agentId
          : resolveSessionAgentId({
              config: cfg,
              sessionKey: key,
              fallbackAgentId: ctx.AgentId ?? agentId,
            });
      const sessionId =
        resolveReplyOperationsForSession({
          sessionKeys: [key],
          agentId: targetAgentId,
        })[0]?.sessionId ??
        (key === resolvedTargetKey
          ? resolvedAbortTarget?.sessionId
          : resolveStoredSessionId({ cfg, sessionKey: key, agentId: targetAgentId }));
      const target = { key, agentId: targetAgentId, sessionId };
      return {
        abort: prepareSessionRunTargetAbort(target),
        clearQueues: prepareSessionLifecycleQueueCleanup({
          ...target,
          keys: [key, sessionId],
          sessionKey: key,
          assertCurrent,
        }),
      };
    };
    const preparedTargets = new Map(
      [resolvedTargetKey, ...(commandSessionKey ? [commandSessionKey] : [])].map(
        (key) => [key, prepareTarget(key)] as const,
      ),
    );
    const conversationBoundAcpTargetKey = commandSessionKey
      ? await resolveBoundAcpAbortTargetSessionKey({
          ctx,
          cfg,
          activeSessionKey: commandSessionKey,
        })
      : undefined;
    const boundAcpTargetKey = !isAcpSessionKey(resolvedTargetKey)
      ? conversationBoundAcpTargetKey
      : undefined;
    const abortTargetKeys = [resolvedTargetKey];
    if (boundAcpTargetKey && boundAcpTargetKey !== resolvedTargetKey) {
      abortTargetKeys.push(boundAcpTargetKey);
    }
    const sourceAbortKey =
      commandSessionKey &&
      !abortTargetKeys.includes(commandSessionKey) &&
      conversationBoundAcpTargetKey &&
      abortTargetKeys.includes(conversationBoundAcpTargetKey)
        ? commandSessionKey
        : undefined;
    const targets = [...abortTargetKeys, ...(sourceAbortKey ? [sourceAbortKey] : [])].map(
      (key) => preparedTargets.get(key) ?? prepareTarget(key),
    );
    let aborted = false;
    let activeAbortRejected = false;
    const acpCancellations: Promise<void>[] = [];
    try {
      const { stopped, failed } = await stopSubagentsForRequester({
        cfg,
        requesterSessionKey,
        requesterAgentId: agentId,
        beforeKill: () => {
          assertCurrent();
          try {
            for (const target of targets) {
              const cleared = target.clearQueues();
              if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
                logVerbose(
                  `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
                );
              }
            }
            for (const target of targets) {
              const outcome = target.abort();
              if (outcome.retirement) {
                // Child settlement may yield before the final join observes this failure.
                void outcome.retirement.catch(() => {});
                acpCancellations.push(outcome.retirement);
              }
              activeAbortRejected ||= outcome.active && !outcome.aborted;
              aborted = outcome.aborted || aborted;
            }
          } finally {
            // The tree already holds queued reservations. Initiate ACP without awaiting
            // either backend so native cleanup cannot delay signal-less ACP steer turns.
            const acpManager = getAcpSessionManager();
            for (const acpTargetKey of abortTargetKeys) {
              const resolution = acpManager.resolveSession({
                cfg,
                sessionKey: acpTargetKey,
                agentId: acpTargetKey === resolvedTargetKey ? agentId : undefined,
              });
              if (resolution.kind === "none") {
                continue;
              }
              acpCancellations.push(
                acpManager
                  .cancelSession({
                    cfg,
                    sessionKey: resolution.sessionKey,
                    agentId: resolution.agentId,
                    reason: "fast-abort",
                  })
                  .catch((error: unknown) => {
                    logVerbose(
                      `abort: ACP cancel failed for ${acpTargetKey}: ${formatErrorMessage(error)}`,
                    );
                  }),
              );
            }
          }
          return true;
        },
      });
      const rejectionReason = activeAbortRejected && !aborted ? "finalizing" : undefined;
      if (!rejectionReason) {
        let persistedAbortTarget: SessionAbortTargetResult | null = null;
        try {
          persistedAbortTarget = await markSessionAbortTarget({
            isCurrent: params.isCommandTargetCurrent,
            expectedTarget: resolvedAbortTarget?.entry ?? null,
            scope: {
              agentId,
              sessionKey: targetKey,
              storePath,
            },
            resolveAbortCutoff: abortCutoffForTarget,
          });
        } catch (error) {
          logVerbose(
            `abort: failed to persist abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
          );
        }
        if (persistedAbortTarget?.persisted === false) {
          logVerbose(
            `abort: failed to persist abort metadata for ${targetKey}: ${persistedAbortTarget.persistenceError ?? "unknown error"}`,
          );
        }
      }
      return {
        handled: true,
        aborted,
        ...(rejectionReason ? { rejectionReason } : {}),
        stoppedSubagents: stopped,
        failedSubagents: failed,
      };
    } finally {
      // Join even when native signaling or metadata exits exceptionally.
      await Promise.all(acpCancellations);
    }
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  const { stopped, failed } = await stopSubagentsForRequester({ cfg, requesterSessionKey });
  return {
    handled: true,
    aborted: false,
    stoppedSubagents: stopped,
    failedSubagents: failed,
  };
}

import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasNonEmptyString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-api.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../agents/embedded-agent-runner/runs.js";
import { captureYieldedMainSessionContinuation } from "../../agents/main-session-recovery/main-session-restart-recovery-target.js";
import {
  clearSessionLifecycleQueues,
  prepareSessionFollowupCleanup,
} from "../../auto-reply/reply/queue/cleanup.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { resolveExistingAgentSessionStoreTargetsAsync } from "../../config/sessions/targets-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { buildAbortedAgentPayload } from "../agent-turn/agent-dedupe.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { waitForChatAbortTerminalPersistence } from "../chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { formatStopRequest } from "../control-plane-audit.js";
import { resolveSessionForRun } from "../server-session-key.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { resolveChatAbortRequester } from "./chat-abort-authorization.js";
import { abortControlledSubagents, descendantAbortError } from "./chat-abort-descendants.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { abortQueuedCollectorSession } from "./chat-abort-runtime.js";
import type { ChatSessionEmbeddedAbortOutcome } from "./chat-abort-runtime.types.js";
import { abortedPartialPersistenceError } from "./chat-aborted-partial.js";
import { createSessionAbortPersistence } from "./session-abort-persistence.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  activeRunSessionKey?: string;
  aliasKeys?: string[];
  agentId?: string;
  defaultAgentId?: string;
}): string {
  if (params.activeRunSessionKey) {
    return params.activeRunSessionKey;
  }
  const candidates = new Set([
    params.canonicalKey,
    params.requestedKey,
    ...(params.aliasKeys ?? []),
  ]);
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.controlUiVisible === false) {
      continue;
    }
    if (candidates.has(active.sessionKey)) {
      const owner = resolveChatRunOwnerAgentId({
        agentId: active.agentId,
        sessionKey: active.sessionKey,
        defaultAgentId: params.defaultAgentId,
      });
      if (!params.agentId || owner === normalizeAgentId(params.agentId)) {
        return active.sessionKey;
      }
    }
  }
  return params.requestedKey;
}

function resolveSessionKeyAgentId(
  sessionKey: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  return parsed?.agentId ?? tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
}

function sessionKeyBelongsToAgent(
  sessionKey: string | undefined,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return resolveSessionKeyAgentId(sessionKey, cfg) === normalizeAgentId(agentId);
}

function resolveScopedAbortKey(params: {
  cfg: OpenClawConfig;
  key: string | undefined;
  agentId: string | undefined;
}): string | undefined {
  const key = normalizeOptionalString(params.key);
  if (!key) {
    return undefined;
  }
  const requestedAgentId = normalizeOptionalString(params.agentId);
  if (!requestedAgentId) {
    return key;
  }
  const scopedAgentId = normalizeAgentId(requestedAgentId);
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  if (ownerAgentId && ownerAgentId !== scopedAgentId) {
    return undefined;
  }
  return resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
}

function sessionAbortResult(abortedRunId: string | null, aborted: boolean, warning?: string) {
  return {
    ok: true,
    abortedRunId,
    status: aborted ? "aborted" : "no-active-run",
    ...(warning ? { warning } : {}),
  };
}

export const sessionAbortHandlers: GatewayRequestHandlers = {
  "sessions.abort": async (options) => {
    const { params, respond, context, client, sessionMutationAuthorization } = options;
    const authority = readGatewayRequestMutationAuthority(options);
    const requester = resolveChatAbortRequester(client, sessionMutationAuthorization);
    const narrow =
      authority.sessionScope === "operator.sessions.write" ||
      requester.sessionAuthority !== undefined;
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    context.logGateway.info(formatStopRequest("sessions.abort", client, params));
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedRunId = readStringValue(p.runId);
    const requestedKey = normalizeOptionalString(p.key);
    const requestedParamAgentId = normalizeOptionalString(p.agentId);
    const clearQueued = p.clearQueued === true;
    const workerRunTarget = requestedRunId
      ? getWorkerInferenceSessionControl(
          context.workerEnvironmentService,
        )?.resolveSessionTargetForRunId(requestedRunId)
      : undefined;
    const embeddedRun = requestedRunId
      ? resolveActiveEmbeddedRunOwnerByRunId(requestedRunId)
      : undefined;
    const embeddedRunSessionKey = embeddedRun?.sessionKey;
    const scopedRequestedKey = resolveScopedAbortKey({
      cfg,
      key: requestedKey,
      agentId: requestedParamAgentId,
    });
    if (requestedKey && requestedParamAgentId && !scopedRequestedKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      );
      return;
    }
    const requestedKeyAgentId = scopedRequestedKey
      ? resolveSessionKeyAgentId(scopedRequestedKey, cfg)
      : undefined;
    const activeRun = requestedRunId ? context.chatAbortControllers.get(requestedRunId) : undefined;
    const activeRunSessionKey = activeRun?.sessionKey;
    const activeRunAgentId = normalizeOptionalString(activeRun?.agentId);
    let inferredRunAgentId =
      requestedParamAgentId ??
      activeRunAgentId ??
      requestedKeyAgentId ??
      workerRunTarget?.agentId ??
      resolveSessionKeyAgentId(activeRunSessionKey, cfg) ??
      resolveSessionKeyAgentId(embeddedRunSessionKey, cfg);
    if (requestedRunId && !inferredRunAgentId) {
      const runOwner = resolveRequestedGlobalAgentId(
        cfg,
        scopedRequestedKey ?? activeRunSessionKey ?? workerRunTarget?.sessionKey ?? "main",
      );
      if (!runOwner.ok) {
        respond(false, undefined, runOwner.error);
        return;
      }
      inferredRunAgentId = runOwner.agentId;
    }
    const requestedRunAgentId = requestedRunId
      ? inferredRunAgentId
        ? normalizeAgentId(inferredRunAgentId)
        : undefined
      : undefined;
    const scopedActiveRunSessionKey = activeRunSessionKey
      ? requestedRunAgentId
        ? sessionKeyBelongsToAgent(activeRunSessionKey, requestedRunAgentId, cfg)
          ? activeRunSessionKey
          : undefined
        : activeRunSessionKey
      : undefined;
    const keyCandidate =
      scopedRequestedKey ??
      scopedActiveRunSessionKey ??
      (requestedRunId
        ? resolveSessionForRun(requestedRunId, {
            agentId: requestedRunAgentId,
            projection: getSessionRowProjection(context),
          })?.sessionKey
        : undefined) ??
      workerRunTarget?.sessionKey ??
      embeddedRunSessionKey;
    if (!keyCandidate && requestedRunId) {
      respond(true, sessionAbortResult(null, false));
      return;
    }
    const key = requireSessionKey(keyCandidate, respond);
    if (!key) {
      return;
    }
    const requestedGlobalAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      requestedParamAgentId ?? requestedRunAgentId,
    );
    if (!requestedGlobalAgent.ok) {
      respond(false, undefined, requestedGlobalAgent.error);
      return;
    }
    const targetAgentId = requestedGlobalAgent.agentId;
    const configuredTarget = isConfiguredSessionStoreAgentId(cfg, targetAgentId);
    const existingTargets = configuredTarget
      ? []
      : await resolveExistingAgentSessionStoreTargetsAsync(cfg, targetAgentId);
    const stableTargetOwner = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
    const hasExactActiveRun = requestedRunId
      ? (scopedActiveRunSessionKey === key &&
          resolveChatRunOwnerAgentId({
            agentId: activeRunAgentId,
            sessionKey: activeRunSessionKey,
            defaultAgentId: stableTargetOwner,
          }) === normalizeAgentId(targetAgentId)) ||
        (embeddedRun !== undefined &&
          resolveSessionKeyAgentId(embeddedRunSessionKey, cfg) === normalizeAgentId(targetAgentId))
      : [...context.chatAbortControllers.values()].some(
          (entry) =>
            entry.controlUiVisible !== false &&
            entry.sessionKey === key &&
            resolveChatRunOwnerAgentId({
              agentId: entry.agentId,
              sessionKey: entry.sessionKey,
              defaultAgentId: stableTargetOwner,
            }) === normalizeAgentId(targetAgentId),
        );
    if (!configuredTarget && existingTargets.length === 0 && !hasExactActiveRun) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${targetAgentId}" not found`),
      );
      return;
    }
    // An exact live controller is already authoritative. Avoid opening the fallback store when
    // neither config nor persistence owns it; that edge is the only one that could create state.
    const loadedSession =
      configuredTarget || existingTargets.length > 0
        ? await withGatewaySessionEntry(
            key,
            { agentId: targetAgentId },
            (selected) => selected,
            cfg,
          )
        : undefined;
    const canonicalKey =
      loadedSession?.canonicalKey ??
      resolveSessionStoreKey({
        cfg,
        sessionKey: key,
        storeAgentId: targetAgentId,
      });
    const sessionEntry = loadedSession?.entry;
    const admittedTarget = sessionMutationAuthorization?.admittedTarget;
    if (
      narrow &&
      (!admittedTarget?.sessionId.trim() ||
        admittedTarget.sessionKey !== canonicalKey ||
        admittedTarget.agentId !== normalizeAgentId(targetAgentId) ||
        sessionEntry?.sessionId !== admittedTarget.sessionId)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
      );
      return;
    }
    const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
    const embeddedRunMatchesSession = Boolean(
      embeddedRun &&
      resolveSessionKeyAgentId(embeddedRun.sessionKey, cfg) === normalizeAgentId(targetAgentId) &&
      (narrow
        ? embeddedRun.sessionId === requiredSessionId &&
          (embeddedRun.sessionKey === key || embeddedRun.sessionKey === canonicalKey)
        : embeddedRun.sessionKey === key ||
          embeddedRun.sessionKey === canonicalKey ||
          sessionEntry?.sessionId === embeddedRun.sessionId),
    );
    if (embeddedRun && !embeddedRunMatchesSession) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match session"),
      );
      return;
    }
    const requestedKeyAliases =
      requestedKey &&
      requestedKey !== key &&
      (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg))
        ? [requestedKey]
        : undefined;
    const resolvedAbortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      activeRunSessionKey: narrow ? undefined : scopedActiveRunSessionKey,
      aliasKeys: requestedKeyAliases,
      agentId: targetAgentId,
      defaultAgentId: stableTargetOwner,
    });
    const abortSessionKey = canonicalKey === "global" ? "global" : resolvedAbortSessionKey;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const lifecycleRevision = sessionEntry?.lifecycleRevision;
    const assertAbortCurrent = composeSessionSourceAssertion([
      authority.assertCurrent,
      sessionMutationAuthorization?.assertCurrent,
      requester.sessionAuthority?.assertCurrent,
      () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
    ]);
    const queueKeys = [key, ...(requestedKeyAliases ?? []), canonicalKey, sessionEntry?.sessionId];
    const clearCapturedFollowups =
      narrow && clearQueued && !requestedRunId && requiredSessionId
        ? prepareSessionFollowupCleanup({
            keys: queueKeys,
            agentId: targetAgentId,
            sessionKey: canonicalKey,
            sessionId: requiredSessionId,
            assertCurrent: assertAbortCurrent,
          })
        : undefined;
    const persistSessionAbort = createSessionAbortPersistence({
      sessionKey: canonicalKey,
      agentId: targetAgentId,
      assertCurrent: assertAbortCurrent,
      lifecycleRevision,
      lifecycleGeneration,
      startedAt: sessionEntry?.startedAt,
    });
    // Controller-backed runs must keep the requester checks and lifecycle cleanup below.
    if (embeddedRun && !activeRun) {
      let aborted = false;
      const descendants = await abortControlledSubagents({
        cfg,
        sessionKey: embeddedRun.sessionKey ?? canonicalKey,
        agentId: targetAgentId,
        requesterTurnRunId: embeddedRun.runId,
        assertCurrent: assertAbortCurrent,
        // A captured handle may decline Stop. Hold its children before signaling,
        // but authorize their cancellation only when this exact parent accepts.
        beforeKill: () => {
          assertAbortCurrent();
          return (aborted = embeddedRun.abort());
        },
      });
      if (aborted) {
        await persistSessionAbort(embeddedRun);
      }
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
      } else {
        respond(true, sessionAbortResult(aborted ? embeddedRun.runId : null, aborted));
      }
      if (aborted) {
        emitSessionsChanged(context, {
          sessionKey: canonicalKey,
          agentId: targetAgentId,
          reason: "abort",
        });
      }
      return;
    }
    // Snapshot before abort can remove controllers. Agent run IDs are idempotency
    // keys, so preserve their dedupe namespace instead of colliding with chat.send.
    const preAbortRuns = new Map(context.chatAbortControllers);
    const preAbortDedupe = new Map(context.dedupe);
    const preAbortSessions = new Map(
      [...preAbortRuns].map(([runId, entry]) => [runId, captureAgentJobSession(entry)]),
    );
    let abortedRunIds: string[] = [];
    let aborted = false;
    let chatAbortSucceeded = false;
    let failedResponse: Parameters<typeof respond> | undefined;
    let descendantsCancelled = false;
    let responseMeta: Record<string, unknown> | undefined;
    let abortWarning: string | undefined;
    const persistedSessionId = sessionEntry?.sessionId;
    let embeddedStop: ChatSessionEmbeddedAbortOutcome | undefined;
    const yieldedRunId = normalizeOptionalString(sessionEntry?.lifecycleRunId);
    const yieldedParent =
      !requestedRunId &&
      yieldedRunId &&
      !preAbortRuns.has(yieldedRunId) &&
      loadedSession &&
      sessionEntry &&
      captureYieldedMainSessionContinuation({
        cfg,
        agentId: targetAgentId,
        sessionKey: canonicalKey,
        storePath: loadedSession.storePath,
        entry: sessionEntry,
      })
        ? {
            runId: yieldedRunId,
            sessionId: sessionEntry.sessionId,
            startedAtMs: sessionEntry.startedAt,
          }
        : undefined;
    let mcpRetirement: Promise<boolean> | undefined;
    let pendingMcpController: ChatAbortControllerEntry | undefined;
    const settleAbortPersistence = async (runIds: readonly string[]) => {
      try {
        await Promise.all(
          runIds.flatMap((runId) => {
            const entry = preAbortRuns.get(runId);
            return entry ? [waitForChatAbortTerminalPersistence(entry)] : [];
          }),
        );
        if (persistedSessionId && pendingMcpController?.controller.signal.aborted) {
          assertAbortCurrent();
          mcpRetirement ??= retireSessionMcpRuntime({
            sessionId: persistedSessionId,
            reason: "session-stop",
          });
        }
        await mcpRetirement;
        if (descendantsCancelled && yieldedParent && !embeddedStop?.capturedRunId) {
          // Child cancellation consumes the wake; join its parent's terminal write too.
          await persistSessionAbort(yieldedParent);
        }
      } catch (error) {
        throw abortedPartialPersistenceError(error, abortWarning);
      }
    };
    const onAuthorizedBeforeEmbeddedAbort =
      !requestedRunId && (clearQueued || persistedSessionId)
        ? () => {
            assertAbortCurrent();
            let queueCleared = false;
            if (clearQueued && canonicalKey !== "global") {
              // Narrow Stop clears captured pending sources. Controller signals own lane
              // entries; clearing a lane by key would also cancel unrelated maintenance.
              if (clearCapturedFollowups) {
                queueCleared = clearCapturedFollowups() > 0;
              } else {
                const cleared = clearSessionLifecycleQueues({
                  keys: queueKeys,
                  agentId: targetAgentId,
                  sessionKey: canonicalKey,
                  assertCurrent: assertAbortCurrent,
                });
                queueCleared = cleared.followupCleared > 0 || cleared.laneCleared > 0;
              }
            }
            return queueCleared;
          }
        : undefined;
    const onAuthorizedAfterQueuedAbort =
      !requestedRunId && (clearQueued || persistedSessionId)
        ? (outcome: ChatSessionEmbeddedAbortOutcome) => {
            assertAbortCurrent();
            embeddedStop = outcome;
            if (clearQueued && outcome.controller) {
              pendingMcpController = outcome.controller;
            }
            if (
              (clearQueued || canonicalKey === "global") &&
              persistedSessionId &&
              (canonicalKey === "global" || !outcome.wasActive || outcome.aborted)
            ) {
              assertAbortCurrent();
              mcpRetirement ??= retireSessionMcpRuntime({
                sessionId: persistedSessionId,
                reason: "session-stop",
              });
            }
            return outcome.aborted;
          }
        : undefined;
    const queuedAbort = abortQueuedCollectorSession({
      context,
      sessionKey: canonicalKey,
      sessionKeyAliases: [key, ...(requestedKeyAliases ?? [])],
      agentId: targetAgentId,
      sessionId: persistedSessionId,
      requiredSessionId,
      session: loadedSession ? { ok: true, value: loadedSession } : undefined,
      defaultAgentId: stableTargetOwner,
      runId: requestedRunId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      assertCurrent: assertAbortCurrent,
      onAuthorizedBeforeEmbeddedAbort,
      onAuthorizedAfterQueuedAbort,
    });
    if (queuedAbort) {
      const result = await queuedAbort;
      if (result.ok) {
        abortWarning = result.value.warning;
      }
      await settleAbortPersistence(result.ok ? result.value.runIds : []);
      if (!result.ok) {
        respond(false, undefined, result.error);
      } else {
        respond(
          true,
          sessionAbortResult(result.value.runIds[0] ?? null, result.value.aborted, abortWarning),
          undefined,
          undefined,
        );
      }
      return;
    }
    await handleChatAbortRequestWithLifecycle(
      bindGatewayRequestHandlerMutationAuthority(
        options,
        {
          ...options,
          params: {
            sessionKey: abortSessionKey,
            runId: requestedRunId,
            agentId: targetAgentId,
          },
          respond: (ok, payload, error, meta) => {
            if (!ok) {
              failedResponse = [ok, payload, error, meta];
              return;
            }
            chatAbortSucceeded = true;
            responseMeta = meta;
            const result = asOptionalObjectRecord(payload);
            abortWarning = normalizeOptionalString(result?.warning);
            const runIds = Array.isArray(result?.runIds)
              ? result.runIds.filter(hasNonEmptyString)
              : [];
            const firstAbortedRunId = runIds[0] ?? null;
            abortedRunIds = runIds;
            aborted = firstAbortedRunId !== null || result?.aborted === true;
            const workerOnly = Boolean(workerRunTarget && !activeRun);
            const embeddedOnly =
              embeddedStop?.aborted &&
              !embeddedStop.controller &&
              embeddedStop.capturedRunId === firstAbortedRunId;
            if (firstAbortedRunId && !workerOnly && !embeddedOnly) {
              const endedAt = Date.now();
              const capturedRun = preAbortRuns.get(firstAbortedRunId);
              const runKind = capturedRun?.kind;
              const dedupePrefix = runKind === "agent" ? "agent" : "chat";
              const dedupeKey = `${dedupePrefix}:${firstAbortedRunId}`;
              // Nested cancellation can yield after the old controller ends. A new
              // receipt owns its outcome; this supplemental timeout must not replace it.
              if (context.dedupe.get(dedupeKey) !== preAbortDedupe.get(dedupeKey)) {
                return;
              }
              setGatewayDedupeEntry({
                dedupe: context.dedupe,
                key: dedupeKey,
                session: preAbortSessions.get(firstAbortedRunId),
                entry: {
                  ts: endedAt,
                  ok: true,
                  payload:
                    runKind === "agent" && capturedRun?.executionStarted === false
                      ? {
                          ...buildAbortedAgentPayload(firstAbortedRunId, "rpc", {
                            agentId: targetAgentId,
                          }),
                          endedAt,
                        }
                      : {
                          status: "timeout",
                          runId: firstAbortedRunId,
                          agentId: targetAgentId,
                          stopReason: "rpc",
                          endedAt,
                        },
                },
              });
            }
          },
        },
        undefined,
      ),
      {
        ...(onAuthorizedBeforeEmbeddedAbort ? { onAuthorizedBeforeEmbeddedAbort } : {}),
        ...(onAuthorizedAfterQueuedAbort ? { onAuthorizedAfterQueuedAbort } : {}),
        ...(!requestedRunId ? { cascadeDescendants: true as const } : {}),
        onDescendantsCancelled: () => {
          descendantsCancelled = true;
        },
      },
    );
    await settleAbortPersistence(abortedRunIds);
    if (!chatAbortSucceeded) {
      if (failedResponse) {
        respond(...failedResponse);
      }
      return;
    }
    respond(
      true,
      sessionAbortResult(abortedRunIds[0] ?? null, aborted, abortWarning),
      undefined,
      responseMeta,
    );
    if (aborted) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        agentId: targetAgentId,
        reason: "abort",
      });
    }
  },
};

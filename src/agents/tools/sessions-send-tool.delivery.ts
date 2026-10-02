import crypto from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithInProcessGatewaySessionMutation } from "../../gateway/server-plugin-in-process-dispatch.js";
import type { GatewaySessionStoreTarget } from "../../gateway/session-utils-store.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEventEntry } from "../../infra/system-events.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  buildAgentMainSessionKey,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
} from "../../routing/session-key.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { listAgentIds } from "../agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
} from "../embedded-agent-runner/runs.js";
import { jsonResult } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";
import {
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { queueSessionsSendSteeringWithCustody } from "./sessions-send-tool.steering.js";

export async function notifySessionsSendSession(params: {
  message: string;
  inputProvenance: InputProvenance;
  sessionKey: string;
  targetAgentId: string;
  idempotencyKey: string;
  runId: string;
  displayKey: string;
}): Promise<ReturnType<typeof jsonResult>> {
  const selection = resolveGatewayToolOperatorSelection();
  const enqueue = () => {
    selection.assertCurrent();
    return enqueueSystemEventEntry(
      annotateInterSessionPromptText(params.message, params.inputProvenance),
      withSystemEventOwner(
        {
          sessionKey: params.sessionKey,
          contextKey: `session-notify:${params.idempotencyKey}`,
        },
        params.targetAgentId,
      ),
    );
  };
  const event = selection.operatorAuthority
    ? await runWithInProcessGatewaySessionMutation(
        "sessions.send",
        { sessionKey: params.sessionKey, agentId: params.targetAgentId },
        (assertCurrent) => {
          assertCurrent();
          return enqueue();
        },
      )
    : enqueue();
  if (!event?.id) {
    return jsonResult({
      runId: params.runId,
      status: "error",
      sessionKey: params.displayKey,
      error: "Notification was not queued.",
    });
  }
  return jsonResult({
    status: "queued",
    sessionKey: params.displayKey,
    notificationId: event.id,
    durability: "process",
    runStarted: false,
  });
}

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  if (!isCronRunSessionKey(sessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const fallbackRest = parsed?.rest.match(/^([\s\S]+):run:[^:]+$/)?.[1];
  return parsed && fallbackRest ? `agent:${parsed.agentId}:${fallbackRest}` : undefined;
}

type SessionsSendDeliveryParams = {
  cfg: OpenClawConfig;
  callGateway: AgentToolGatewayRequestCaller;
  runId: string;
  sendParams: Record<string, unknown> & {
    message: string;
    agentId: string;
    inputProvenance: InputProvenance;
    sourceReplyDeliveryMode: "message_tool_only";
  };
  sessionKey: string;
  sessionStoreTarget: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
  expectedSessionId?: string;
  retainAcceptance?: boolean;
  assertDispatchCurrent?: () => void;
  sourceOrigin?: DeliveryContext;
  mode?: "steer" | "followup";
};

type SessionsSendStart =
  | {
      ok: true;
      runId: string;
      targetDisposition: "queued" | "steered";
      steeredRunId?: string;
      a2aSessionKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> };

/** Decide steering before preparing custody for a new turn. */
export async function trySessionsSendActiveRunDelivery(
  params: SessionsSendDeliveryParams,
  ownChild: boolean,
): Promise<SessionsSendStart | { fallbackSessionKey?: string }> {
  const assertCaller = captureGatewayToolCallerAssertion();
  try {
    const selection = resolveGatewayToolOperatorSelection();
    selection.assertCurrent();
    let fallbackSessionKey: string | undefined;
    const activeRunSessionId =
      params.mode === "steer" ||
      (params.mode !== "followup" &&
        params.allowActiveRunQueueDelivery &&
        (ownChild || isRunScopedAgentSessionKey(params.sessionKey)))
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    if (params.mode === "steer" && !activeRunSessionId) {
      throw new Error(
        "Target has no active run that accepts steering. Use mode=followup to start a new turn.",
      );
    }
    if (
      activeRunSessionId &&
      params.expectedSessionId &&
      activeRunSessionId !== params.expectedSessionId
    ) {
      throw new Error("active run session incarnation changed");
    }
    const { inputProvenance, message: messageText, sourceReplyDeliveryMode } = params.sendParams;
    if (activeRunSessionId && messageText) {
      const queue = async (
        assertCurrent: () => void,
        lifecycle: Pick<
          EmbeddedAgentQueueMessageOptions,
          "onQueueAccepted" | "onQueueSettled"
        > = {},
      ) => {
        const queueOptions: EmbeddedAgentQueueMessageOptions = {
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: params.deliveryTimeoutMs,
          ...lifecycle,
          // Waiting for a busy run's transcript would withdraw accepted guidance at the deadline.
          ...(params.mode === "steer" || ownChild
            ? { waitForTranscriptCommit: false }
            : { waitForTranscriptCommit: true, sourceReplyDeliveryMode }),
          // The receiving runtime owns transcript writes to this exact incarnation.
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            assertOriginalInputCommit: assertCurrent,
            input: {
              text: messageText,
              provenance: inputProvenance,
              ...(inputProvenance.sourceRole === "subagent" ? { display: false as const } : {}),
              idempotencyKey: buildRunUserTurnIdempotencyKey(params.runId),
            },
            target: {
              sessionId: activeRunSessionId,
              expectedSessionId: activeRunSessionId,
              sessionKey: params.sessionStoreTarget.canonicalKey,
              sessionEntry: undefined,
              agentId: params.sessionStoreTarget.agentId,
              storePath: params.sessionStoreTarget.storePath,
              config: params.cfg,
            },
          }),
        };
        const dispatchQueue = (options: EmbeddedAgentQueueMessageOptions) =>
          selection.operatorAuthority || assertCaller
            ? queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
                activeRunSessionId,
                messageText,
                options,
                () => {
                  assertCurrent();
                  if (!selection.operatorAuthority) {
                    assertCaller?.("agent");
                  }
                  return true;
                },
              )
            : queueEmbeddedAgentMessageWithOutcomeAsync(activeRunSessionId, messageText, options);
        assertCurrent();
        let outcome = await dispatchQueue(queueOptions);
        if (!outcome.queued && outcome.reason === "transcript_commit_wait_unsupported") {
          const bestEffortQueueOptions = { ...queueOptions };
          delete bestEffortQueueOptions.waitForTranscriptCommit;
          outcome = await dispatchQueue(bestEffortQueueOptions);
        }
        return outcome;
      };
      const queueOutcome = selection.operatorAuthority
        ? await queueSessionsSendSteeringWithCustody(
            { sessionKey: params.sessionKey, agentId: params.sendParams.agentId },
            selection.assertCurrent,
            queue,
          )
        : await queue(selection.assertCurrent);
      if (queueOutcome.queued) {
        return {
          ok: true,
          runId: params.runId,
          targetDisposition: "steered",
          steeredRunId: queueOutcome.runId,
        };
      }
      fallbackSessionKey = ownChild
        ? undefined
        : resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.mode === "steer" ||
        (!ownChild && (params.expectedSessionId || !fallbackSessionKey)) ||
        (!ownChild &&
          queueOutcome.reason !== "not_streaming" &&
          queueOutcome.reason !== "no_active_run" &&
          queueOutcome.reason !== "stale_run")
      ) {
        throw new Error(
          formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected",
        );
      }
    }
    return { fallbackSessionKey };
  } catch (error) {
    return deliveryFailure(params, error);
  }
}

export async function startSessionsSendAgentRun(
  params: SessionsSendDeliveryParams & { fallbackSessionKey?: string },
): Promise<SessionsSendStart> {
  const { fallbackSessionKey } = params;
  try {
    // Self-sends retain the captured conversation; a distinct Cron parent uses its own route.
    const sourceOrigin = fallbackSessionKey ? undefined : params.sourceOrigin;
    const sendParams = sourceOrigin
      ? {
          ...params.sendParams,
          channel: sourceOrigin.channel ?? params.sendParams.channel,
          accountId: sourceOrigin.accountId,
          to: sourceOrigin.to,
          threadId: stringifyRouteThreadId(sourceOrigin.threadId),
        }
      : params.sendParams;
    const accepted = params.retainAcceptance
      ? createDeferredCore<{ runId: string; admissionPending?: boolean }>()
      : undefined;
    const responsePromise = params.callGateway<{ runId: string; admissionPending?: boolean }>({
      method: "agent",
      params: fallbackSessionKey
        ? {
            ...sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          }
        : sendParams,
      timeoutMs: 10_000,
      assertDispatchCurrent: params.assertDispatchCurrent,
      ...(accepted
        ? {
            expectFinal: true,
            onAccepted: (payload: unknown) => {
              const receipt = asOptionalRecord(payload);
              if (
                receipt?.status === "accepted" &&
                typeof receipt.runId === "string" &&
                receipt.admissionPending !== true
              ) {
                accepted.resolve({ runId: receipt.runId });
              }
            },
          }
        : {}),
    });
    // The admission receipt survives a later final-response failure; the registry owns the result.
    const response = await (accepted
      ? Promise.race([accepted.promise, responsePromise])
      : responsePromise);
    const responseRunId =
      typeof response?.runId === "string" && response.runId ? response.runId : params.runId;
    if (response?.admissionPending === true) {
      return {
        ok: false,
        result: jsonResult({
          runId: responseRunId,
          status: "error",
          error: "Gateway admission is still pending; inspect this run before retrying.",
          sentBeforeError: true,
          sessionKey: fallbackSessionKey ?? params.sessionKey,
        }),
      };
    }
    return {
      ok: true,
      runId: responseRunId,
      targetDisposition: "queued",
      ...(fallbackSessionKey ? { a2aSessionKey: fallbackSessionKey } : {}),
    };
  } catch (err) {
    return deliveryFailure(params, err);
  }
}

function deliveryFailure(params: SessionsSendDeliveryParams, error: unknown) {
  return {
    ok: false as const,
    result: jsonResult({
      runId: params.runId,
      status: "error",
      error: error instanceof Error ? error.message : typeof error === "string" ? error : "error",
      sessionKey: params.sessionKey,
    }),
  };
}

export function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return buildAgentMainSessionKey({ agentId, mainKey: params.mainKey });
}

export function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  mainKey: string;
}): boolean {
  if (isUnscopedSessionKeySentinel(params.sessionKey)) {
    return false;
  }
  if (params.sessionKey === params.mainKey) {
    return true;
  }
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  return agentId
    ? params.sessionKey ===
        resolveConfiguredAgentMainSessionKey({
          cfg: params.cfg,
          agentId,
          mainKey: params.mainKey,
        })
    : false;
}

export async function createConfiguredAgentMainSession(params: {
  callGateway: AgentToolGatewayRequestCaller;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const createParams = {
      key: params.sessionKey,
      agentId: params.agentId,
    };
    if (
      params.useTrustedInProcessCreation &&
      params.requesterSessionKey &&
      hasInProcessGatewayToolContext()
    ) {
      // sessions.create serializes keyed creation and adopts an existing row,
      // so concurrent first sends can safely race after the missing resolution.
      await callInProcessGatewayToolWithCreation("sessions.create", createParams, {
        via: "internal",
        actor: { type: "agent", id: params.requesterSessionKey },
      });
    } else {
      await params.callGateway({
        method: "sessions.create",
        params: createParams,
        timeoutMs: 10_000,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

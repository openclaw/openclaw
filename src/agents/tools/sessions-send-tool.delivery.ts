/** Executes new turns and active-run steering for sessions_send. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionStoreTarget } from "../../gateway/session-utils-store.types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../embedded-agent-runner/runs.js";
import { jsonResult } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued &&
    (outcome.reason === "not_streaming" ||
      outcome.reason === "no_active_run" ||
      outcome.reason === "stale_run")
  );
}

export async function startSessionsSendAgentRun(params: {
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
  allowActiveRunQueueFallback?: boolean;
  expectedSessionId?: string;
  sourceOrigin?: DeliveryContext;
  mode?: "steer" | "followup";
}): Promise<
  | {
      ok: true;
      runId: string;
      targetDisposition: "queued" | "steered";
      a2aSessionKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  let dispatchedSessionKey = params.sessionKey;
  let dispatchedRunId = params.runId;
  let gatewayDispatchStarted = false;
  try {
    let fallbackSessionKey: string | undefined;
    const activeRunSessionId =
      params.mode === "steer" ||
      (params.mode !== "followup" &&
        params.allowActiveRunQueueDelivery &&
        isRunScopedAgentSessionKey(params.sessionKey))
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
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(params.mode === "steer" ? {} : { sourceReplyDeliveryMode }),
        // Carry the same input facts as a new run; transcript ownership stays
        // with the receiving runtime and its exact session incarnation.
        userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
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
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
        );
      }
      if (queueOutcome.queued) {
        return { ok: true, runId: params.runId, targetDisposition: "steered" };
      }
      fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.allowActiveRunQueueFallback === false ||
        params.mode === "steer" ||
        !fallbackSessionKey ||
        !shouldFallbackCronRunScopedActiveDelivery(queueOutcome)
      ) {
        throw new Error(
          formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected",
        );
      }
    }
    // Preserve a self-send's source conversation without parsing its session key
    // or consulting a route that another inbound turn can replace. A Cron parent
    // fallback is a distinct session and keeps its own delivery context.
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
    const requestParams = fallbackSessionKey
      ? {
          ...sendParams,
          sessionKey: fallbackSessionKey,
          idempotencyKey: crypto.randomUUID(),
        }
      : sendParams;
    dispatchedSessionKey = fallbackSessionKey ?? params.sessionKey;
    dispatchedRunId =
      typeof requestParams.idempotencyKey === "string"
        ? requestParams.idempotencyKey
        : params.runId;
    gatewayDispatchStarted = true;
    const response = await params.callGateway<{ runId: string; admissionPending?: boolean }>({
      method: "agent",
      params: requestParams,
      timeoutMs: 10_000,
    });
    const responseRunId =
      typeof response?.runId === "string" && response.runId ? response.runId : dispatchedRunId;
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
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    const dispatchTimeout =
      gatewayDispatchStarted && err instanceof GatewayProtocolRequestTimeoutError ? err : undefined;
    return {
      ok: false,
      result: jsonResult({
        runId: dispatchedRunId,
        status: "error",
        error: dispatchTimeout?.requestSent
          ? `${messageText}. Session send is unconfirmed: the request may still be accepted. Inspect the original run and target session before retrying; a new send can duplicate the message.`
          : messageText,
        sessionKey: dispatchedSessionKey,
        ...(dispatchTimeout
          ? {
              dispatch: {
                outcome: dispatchTimeout.requestSent ? "unknown" : "not_sent",
                code: dispatchTimeout.code,
                method: dispatchTimeout.method,
                requestSent: dispatchTimeout.requestSent,
                timeoutMs: dispatchTimeout.timeoutMs,
                idempotencyKey: dispatchedRunId,
              },
            }
          : {}),
      }),
    };
  }
}

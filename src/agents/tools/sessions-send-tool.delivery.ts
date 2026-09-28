/** Executes new turns and active-run steering for sessions_send. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionStoreTarget } from "../../gateway/session-utils-store.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../embedded-agent-runner/runs.js";
import { jsonResult } from "./common.js";
import {
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

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
  const fallbackRest = parsed?.rest.match(/^([\s\S]+):run:[^:]+$/)?.[1];
  return parsed && fallbackRest ? `agent:${parsed.agentId}:${fallbackRest}` : undefined;
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
  sourceOrigin?: DeliveryContext;
  mode?: "steer" | "followup";
};

type SessionsSendStart =
  | {
      ok: true;
      runId: string;
      targetDisposition: "queued" | "steered";
      a2aSessionKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> };

/** Decide steering before preparing custody for a new turn. */
export async function trySessionsSendActiveRunDelivery(
  params: SessionsSendDeliveryParams,
  ownChild: boolean,
): Promise<SessionsSendStart | { fallbackSessionKey?: string }> {
  try {
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
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        // Explicit steering acknowledges admission without waiting for a busy run's transcript.
        ...(params.mode === "steer"
          ? { waitForTranscriptCommit: false }
          : { waitForTranscriptCommit: true, sourceReplyDeliveryMode }),
        // The receiving runtime owns transcript writes to this exact incarnation.
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
      fallbackSessionKey = ownChild
        ? undefined
        : resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.mode === "steer" ||
        (!ownChild && (params.expectedSessionId || !fallbackSessionKey)) ||
        !shouldFallbackCronRunScopedActiveDelivery(queueOutcome)
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
    const response = await params.callGateway<{ runId: string; admissionPending?: boolean }>({
      method: "agent",
      params: fallbackSessionKey
        ? {
            ...sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          }
        : sendParams,
      timeoutMs: 10_000,
    });
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

export async function createConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: AgentToolGatewayRequestCaller;
  agentId?: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const targetAgentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  try {
    const createParams = {
      key: params.sessionKey,
      agentId: targetAgentId,
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

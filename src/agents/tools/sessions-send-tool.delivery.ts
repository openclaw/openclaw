/** Delivers notifications, new turns, and active-run steering for sessions_send. */
import crypto from "node:crypto";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithInProcessGatewaySessionMutation } from "../../gateway/server-plugin-in-process-dispatch.js";
import type { GatewaySessionStoreTarget } from "../../gateway/session-utils-store.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEventEntry } from "../../infra/system-events.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
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
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
} from "../embedded-agent-runner/runs.js";
import { jsonResult } from "./common.js";
import { resolveGatewayToolOperatorSelection } from "./gateway-caller-context.js";
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
          selection.operatorAuthority
            ? queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
                activeRunSessionId,
                messageText,
                options,
                () => {
                  assertCurrent();
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
        return { ok: true, runId: params.runId, targetDisposition: "steered" };
      }
      fallbackSessionKey = ownChild
        ? undefined
        : resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.mode === "steer" ||
        (!ownChild && (params.expectedSessionId || !fallbackSessionKey)) ||
        (!ownChild && !shouldFallbackCronRunScopedActiveDelivery(queueOutcome))
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
  let dispatchedSessionKey = params.sessionKey;
  let dispatchedRunId = params.runId;
  let gatewayDispatchStarted = false;
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
    return deliveryFailure(
      { sessionKey: dispatchedSessionKey, runId: dispatchedRunId },
      err,
      gatewayDispatchStarted,
    );
  }
}

function deliveryFailure(
  params: Pick<SessionsSendDeliveryParams, "sessionKey" | "runId">,
  error: unknown,
  gatewayDispatchStarted = false,
) {
  const messageText =
    error instanceof Error ? error.message : typeof error === "string" ? error : "error";
  const dispatchTimeout =
    gatewayDispatchStarted && error instanceof GatewayProtocolRequestTimeoutError
      ? error
      : undefined;
  return {
    ok: false as const,
    result: jsonResult({
      runId: params.runId,
      status: "error",
      error: dispatchTimeout?.requestSent
        ? `${messageText}. Session send is unconfirmed: the request may still be accepted. Inspect the original run and target session before retrying; a new send can duplicate the message.`
        : messageText,
      sessionKey: params.sessionKey,
      ...(dispatchTimeout
        ? {
            dispatch: {
              outcome: dispatchTimeout.requestSent ? "unknown" : "not_sent",
              code: dispatchTimeout.code,
              method: dispatchTimeout.method,
              requestSent: dispatchTimeout.requestSent,
              timeoutMs: dispatchTimeout.timeoutMs,
              idempotencyKey: params.runId,
            },
          }
        : {}),
    }),
  };
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

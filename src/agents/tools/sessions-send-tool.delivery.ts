import crypto from "node:crypto";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentSelfHeldRefusal } from "../../gateway/agent-turn/agent-admission-refusal.js";
import { runWithInProcessGatewaySessionMutation } from "../../gateway/server-plugin-in-process-dispatch.js";
import type { GatewaySessionStoreTarget } from "../../gateway/session-utils-store.types.js";
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
import type { ReplyMessageInjectionOptions } from "../../sessions/session-controller.contracts.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import {
  steerSessionControllerOperation,
  type SessionControllerSteerResult,
} from "../../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { listAgentIds } from "../agent-scope.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { resolveSenderRestrictedSpawnError } from "../spawn-requester-policy.js";
import { jsonResult } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";
import {
  bindAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import type { SessionSendReplyAdmission } from "./sessions-send-communication.js";
import { queueSessionsSendSteeringWithCustody } from "./sessions-send-tool.steering.js";
import type { AgentStepSession } from "./sessions-send-tool.types.js";

// Bind at dispatch: child followup custody installs its context after tool construction.
export const callSessionsSendGateway: AgentToolGatewayRequestCaller = async <T>(
  request: Parameters<AgentToolGatewayRequestCaller>[0],
): Promise<T> => await bindAgentToolGatewayRequest({ revalidateOnCompletion: false })<T>(request);

export function buildSessionsSendAgentParams(params: {
  message: string;
  agentId: string;
  sessionKey: string;
  idempotencyKey: string;
  nativeChild: boolean;
  inputProvenance: InputProvenance;
}) {
  return {
    message: params.message,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    idempotencyKey: params.idempotencyKey,
    deliver: false,
    // Native children return through their completion owner, without a message tool.
    sourceReplyDeliveryMode: params.nativeChild
      ? ("automatic" as const)
      : ("message_tool_only" as const),
    channel: INTERNAL_MESSAGE_CHANNEL,
    lane: resolveNestedAgentLaneForSession(params.sessionKey),
    inputProvenance: params.inputProvenance,
  };
}

export async function notifySessionsSendSession(params: {
  message: string;
  inputProvenance: InputProvenance;
  sessionKey: string;
  targetAgentId: string;
  runId: string;
  displayKey: string;
  assertCurrent?: () => void;
}): Promise<ReturnType<typeof jsonResult>> {
  const selection = resolveGatewayToolOperatorSelection();
  const enqueue = () => {
    selection.assertCurrent();
    params.assertCurrent?.();
    return enqueueSystemEventEntry(
      annotateInterSessionPromptText(params.message, params.inputProvenance),
      withSystemEventOwner(
        {
          sessionKey: params.sessionKey,
          contextKey: `session-notify:${params.runId}`,
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

type SessionsSendDeliveryParams = {
  cfg: OpenClawConfig;
  admissionConfig: OpenClawConfig;
  callGateway: AgentToolGatewayRequestCaller;
  callDurableGateway?: AgentToolGatewayRequestCaller;
  runId: string;
  sendParams: Record<string, unknown> & {
    message: string;
    agentId: string;
    inputProvenance: InputProvenance;
    sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  };
  sessionKey: string;
  sessionStoreTarget: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
  allowActiveRunQueueDelivery?: boolean;
  expectedSessionId?: string;
  /** Communication binds an incarnation without claiming result ownership or forbidding Cron fallback. */
  preparedTargetSessionId?: string;
  retainAcceptance?: boolean;
  captureReplyAdmission?: (runId: string) => SessionSendReplyAdmission;
  assertDispatchCurrent?: () => void;
  // Destination policy fences input commit, not an already accepted acknowledgment.
  assertSendCurrent?: () => void;
  sourceOrigin?: DeliveryContext;
  /** A Cron fallback is another exact recipient and needs its own admission. */
  prepareFallback?: (sessionKey: string) => Promise<{
    targetSession?: AgentStepSession;
    captureReplyAdmission?: (runId: string) => SessionSendReplyAdmission;
    callGateway: AgentToolGatewayRequestCaller;
    assertCurrent: () => void;
    close: () => void;
  }>;
  mode?: "steer" | "followup";
};

export type SessionsSendStart =
  | {
      ok: true;
      runId: string;
      targetDisposition: "queued" | "steered";
      steeredRunId?: string;
      a2aSessionKey?: string;
      a2aSession?: AgentStepSession;
      replyAdmission?: SessionSendReplyAdmission;
    }
  | {
      ok: false;
      result: ReturnType<typeof jsonResult<Record<string, unknown>>>;
      selfHeld?: ReturnType<typeof readAgentSelfHeldRefusal>;
    };

/** Rejections that leave a Cron run-scoped target to its durable parent session. */
const FALLBACK_STEER_REJECTIONS = new Set<
  Extract<SessionControllerSteerResult, { status: "rejected" }>["reason"]
>(["no_active_run", "not_running", "stale_run", "injection_unavailable"]);

/** Decide steering before preparing custody for a new turn. */
export async function trySessionsSendActiveRunDelivery(
  params: SessionsSendDeliveryParams,
  ownChild: boolean,
): Promise<
  SessionsSendStart | { fallbackSessionKey?: string; callGateway?: AgentToolGatewayRequestCaller }
> {
  const assertCaller = captureGatewayToolCallerAssertion();
  try {
    const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
    selection.assertCurrent();
    let fallbackSessionKey: string | undefined;
    const activeOperation =
      params.mode === "steer" ||
      (params.mode !== "followup" &&
        params.allowActiveRunQueueDelivery &&
        (ownChild || isRunScopedAgentSessionKey(params.sessionKey)))
        ? getSessionControllerOperation(
            params.sessionStoreTarget.canonicalKey,
            captureSessionTarget({
              storeScope: params.sessionStoreTarget.storePath,
              sessionKey: params.sessionStoreTarget.canonicalKey,
              agentId: params.sessionStoreTarget.agentId,
            }),
          )
        : undefined;
    const activeRunSessionId = activeOperation?.sessionId;
    if (params.mode === "steer" && !activeRunSessionId) {
      throw new Error(
        "Target has no active run that accepts steering. Use mode=followup to start a new turn.",
      );
    }
    const expectedActiveSessionId = params.expectedSessionId ?? params.preparedTargetSessionId;
    if (
      activeRunSessionId &&
      expectedActiveSessionId &&
      activeRunSessionId !== expectedActiveSessionId
    ) {
      throw new Error("active run session incarnation changed");
    }
    const { inputProvenance, message: messageText } = params.sendParams;
    if (activeOperation && activeRunSessionId && messageText) {
      const requesterOrigin = selection.requesterOrigin;
      if (!requesterOrigin) {
        if (params.mode === "steer") {
          throw new Error('Cannot verify requester identity for steering; use mode: "followup".');
        }
        return {};
      }
      const queue = async (
        assertCurrent: () => void,
        lifecycle: Pick<ReplyMessageInjectionOptions, "onQueueAccepted" | "onQueueSettled"> = {},
      ) => {
        let accepted = false;
        const assertInputCurrent = () => {
          assertCurrent();
          if (!accepted) {
            params.assertSendCurrent?.();
          }
        };
        const guarded = Boolean(
          selection.operatorAuthority || assertCaller || params.assertSendCurrent,
        );
        assertInputCurrent();
        const queueOptions: ReplyMessageInjectionOptions = {
          requesterToolAuthority: {
            requesterOrigin,
            config: params.admissionConfig,
          },
          steeringMode: "all",
          debounceMs: 0,
          // Reply waiting and durable admission have separate deadlines.
          deliveryTimeoutMs: undefined,
          ...lifecycle,
          onQueueAccepted: (value) => {
            // Accepted guidance belongs to the receiver, not the sender's later policy.
            accepted ||= value;
            lifecycle.onQueueAccepted?.(value);
          },
          // Source-bound authority admits only guarded (V2) injection.
          ...(guarded
            ? {
                assertCurrent: () => {
                  assertInputCurrent();
                  if (!selection.operatorAuthority) {
                    assertCaller?.("sessions.send");
                  }
                },
              }
            : {}),
          waitForTranscriptCommit: true,
          // The receiving runtime owns transcript writes to this exact incarnation.
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            assertOriginalInputCommit: assertInputCurrent,
            input: {
              text: messageText,
              provenance: inputProvenance,
              requesterOrigin,
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
        return await steerSessionControllerOperation({
          operation: activeOperation,
          text: messageText,
          // A status-only inter-session input cannot abort the receiving turn.
          abortOnUnconfirmedTranscript: false,
          options: queueOptions,
        });
      };
      const steer = selection.operatorAuthority
        ? await queueSessionsSendSteeringWithCustody(
            {
              sessionKey: params.sessionKey,
              sessionId: activeRunSessionId,
              agentId: params.sendParams.agentId,
            },
            activeOperation,
            selection.assertCurrent,
            queue,
          )
        : await queue(selection.assertCurrent);
      if (steer.status === "accepted") {
        return {
          ok: true,
          runId: params.runId,
          targetDisposition: "steered",
          steeredRunId: steer.targetRunId,
        };
      }
      if (steer.status === "indeterminate") {
        // Consumed without a confirmed commit: never replay it as a new turn.
        throw new Error(steer.errorMessage);
      }
      if (
        steer.reason === "requester_origin_mismatch" ||
        steer.reason === "tool_authority_mismatch"
      ) {
        if (params.mode === "steer") {
          throw new Error(
            steer.reason === "requester_origin_mismatch"
              ? 'Active run has a different requester; use mode: "followup".'
              : 'Requester policy does not match the active run; use mode: "followup".',
          );
        }
        return {};
      }
      if (steer.reason === "transcript_commit_wait_unsupported") {
        if (!params.callDurableGateway) {
          throw new Error("The target cannot accept restart-durable steering from this caller.");
        }
        // Capability rejection precedes injection, so the same input can safely queue once.
        return { callGateway: params.callDurableGateway };
      }
      // A definite capability refusal leaves ordinary input on its captured
      // conversation. Revocation and uncertain native commitment never retry.
      if (
        params.mode !== "steer" &&
        params.allowActiveRunQueueDelivery &&
        !isCronRunSessionKey(params.sessionKey) &&
        FALLBACK_STEER_REJECTIONS.has(steer.reason)
      ) {
        return {};
      }
      fallbackSessionKey = ownChild
        ? undefined
        : resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (
        params.mode === "steer" ||
        (!ownChild && (params.expectedSessionId || !fallbackSessionKey)) ||
        (!ownChild && !FALLBACK_STEER_REJECTIONS.has(steer.reason))
      ) {
        const errorPart = steer.errorMessage ? ` error=${steer.errorMessage}` : "";
        throw new Error(
          `queue_message_failed reason=${steer.reason} sessionId=${activeRunSessionId} gatewayHealth=live${errorPart}`,
        );
      }
    }
    return { fallbackSessionKey };
  } catch (error) {
    return deliveryFailure(params, error);
  }
}

function resolveSendMutationGuards(
  params: Pick<SessionsSendDeliveryParams, "assertDispatchCurrent" | "assertSendCurrent">,
) {
  if (params.assertSendCurrent && !hasInProcessGatewayToolContext()) {
    // Standalone operator clients can fence wire submission, not attach a host-only commit callback.
    return {
      assertDispatchCurrent: () => {
        params.assertDispatchCurrent?.();
        params.assertSendCurrent?.();
      },
    };
  }
  return {
    assertDispatchCurrent: params.assertDispatchCurrent,
    ...(params.assertSendCurrent ? { sessionMutationCommitGuard: params.assertSendCurrent } : {}),
  };
}

export async function startSessionsSendAgentRun(
  params: SessionsSendDeliveryParams & { fallbackSessionKey?: string },
): Promise<SessionsSendStart> {
  const { fallbackSessionKey } = params;
  const caller = getGatewayToolCallerIdentity();
  let fallback:
    | Awaited<ReturnType<NonNullable<SessionsSendDeliveryParams["prepareFallback"]>>>
    | undefined;
  try {
    const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
    if (fallbackSessionKey) {
      fallback = await params.prepareFallback?.(fallbackSessionKey);
    }
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
    const assertSendCurrent = fallback?.assertCurrent ?? params.assertSendCurrent;
    assertSendCurrent?.();
    const responsePromise = (fallback?.callGateway ?? params.callGateway)<{
      runId: string;
      admissionPending?: boolean;
    }>({
      method: "agent",
      ...(caller && selection.requesterOrigin
        ? {
            agentToolCaller: {
              agentId: caller.agentId,
              sessionKey: caller.sessionKey,
              requesterOrigin: selection.requesterOrigin,
            },
          }
        : {}),
      params: fallbackSessionKey
        ? {
            ...sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          }
        : sendParams,
      timeoutMs: 10_000,
      ...resolveSendMutationGuards({ ...params, assertSendCurrent }),
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
      replyAdmission: params.retainAcceptance
        ? undefined
        : (fallback?.captureReplyAdmission ?? params.captureReplyAdmission)?.(responseRunId),
      ...(fallbackSessionKey
        ? { a2aSessionKey: fallbackSessionKey, a2aSession: fallback?.targetSession }
        : {}),
    };
  } catch (err) {
    const failure = deliveryFailure(params, err);
    // A separately selected fallback has another operation identity; never retain it as this send.
    return fallbackSessionKey ? { ok: false, result: failure.result } : failure;
  } finally {
    fallback?.close();
  }
}

function deliveryFailure(params: SessionsSendDeliveryParams, error: unknown) {
  return {
    selfHeld: readAgentSelfHeldRefusal(error),
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
  mode?: "followup" | "steer" | "notify" | "resume";
  inheritedToolPolicySource?: "sender";
  callGateway: AgentToolGatewayRequestCaller;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
  assertCurrent?: () => void;
}): Promise<void> {
  const requesterPolicyError = resolveSenderRestrictedSpawnError({ ...params, visible: true });
  if (requesterPolicyError) {
    throw new Error(requesterPolicyError);
  }
  if (params.mode === "steer" || params.mode === "notify" || params.mode === "resume") {
    throw new Error(
      "Cannot notify, steer, or resume a missing session. Use mode=followup to start a new turn.",
    );
  }
  try {
    params.assertCurrent?.();
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
      await callInProcessGatewayToolWithCreation(
        "sessions.create",
        createParams,
        {
          via: "internal",
          actor: { type: "agent", id: params.requesterSessionKey },
        },
        { sessionMutationCommitGuard: params.assertCurrent },
      );
    } else {
      await params.callGateway({
        method: "sessions.create",
        params: createParams,
        ...resolveSendMutationGuards({ assertSendCurrent: params.assertCurrent }),
        timeoutMs: 10_000,
      });
    }
  } catch (err) {
    throw new Error(formatErrorMessage(err), { cause: err });
  }
}

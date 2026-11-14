import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { assertChatSendSessionTargetOrRespond } from "./chat-send-admission-context.js";
import { consumeChatSendCurrent } from "./chat-send-pre-admission.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { observeChatSendWork } from "./chat-send-work-admission.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/** Join started preparation before releasing its existing controller and caller custody. */
export async function prepareAdmittedChatSendDispatch({
  params,
  runAbort,
  admission,
  releaseCaller,
  assertSessionTargetCurrent,
}: {
  params: ChatSendPreAdmissionParams & {
    session: PreparedChatSendSession;
    onAdmissionOwned?: () => Promise<boolean>;
  };
  runAbort: ReturnType<typeof registerChatAbortController>;
  admission: Pick<SessionEffectRef, "release" | "run">;
  releaseCaller: () => void;
  assertSessionTargetCurrent: () => void;
}) {
  const { respond } = params;
  let releaseGatewayRootContinuation = () => {};
  let releaseCallerAuthority: (() => void) | undefined = releaseCaller;
  const cleanup = () => {
    try {
      runAbort.cleanup();
      admission.release();
      releaseGatewayRootContinuation();
    } finally {
      releaseCallerAuthority?.();
      releaseCallerAuthority = undefined;
    }
  };
  let startedWork: (() => Promise<unknown>) | undefined;
  try {
    if (!assertChatSendSessionTargetOrRespond({ assertSessionTargetCurrent, cleanup, respond })) {
      return undefined;
    }
    const pending = await consumeChatSendCurrent(params, () => {
      runAbort.controller.signal.throwIfAborted();
      // Detached dispatch keeps the live request root through terminal persistence.
      releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? (() => {});
      const ownedWork = params.onAdmissionOwned
        ? observeChatSendWork(admission.run(params.onAdmissionOwned))
        : undefined;
      startedWork = ownedWork;
      return { admission: ownedWork };
    });
    if (pending.admission) {
      if (!(await pending.admission())) {
        cleanup();
        return undefined;
      }
      await consumeChatSendCurrent(params, () => true);
    }
    if (!assertChatSendSessionTargetOrRespond({ assertSessionTargetCurrent, cleanup, respond })) {
      return undefined;
    }
  } catch (error) {
    if (startedWork) {
      await Promise.allSettled([startedWork()]);
    }
    cleanup();
    throw error;
  }
  return { releaseCallerAuthority, releaseGatewayRootContinuation };
}

/** Own cleanup after chat admission transfers work beyond the request frame. */
export function createAdmittedChatSendCleanup(params: {
  cleanupAbort: () => void;
  releaseRetainedWork: () => void;
}) {
  let discardPreparedMedia: (() => void) | undefined;
  return {
    cleanup: () => {
      params.cleanupAbort();
      params.releaseRetainedWork();
      discardPreparedMedia?.();
      discardPreparedMedia = undefined;
    },
    setDiscardPreparedMedia: (discard: (() => void) | undefined) => {
      discardPreparedMedia = discard;
    },
  };
}

/** Publish Stop from the captured source identity before releasing its admitted custody. */
export function finishAbortedChatSend(params: {
  context: Pick<GatewayRequestContext, "dedupe">;
  respond: RespondFn;
  runId: string;
  lifecycleGeneration: string;
  stopReason?: string;
  sourceRef: RpcSourceRef;
  cleanup: () => void;
}) {
  const endedAt = Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason ?? "rpc",
    endedAt,
  });
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    session: captureAgentJobSession({
      ...getRpcSourceIdentity(params.sourceRef),
      lifecycleGeneration: params.lifecycleGeneration,
    }),
    entry: { ts: endedAt, ok: true, payload },
  });
  params.cleanup();
  clearAgentRunContext(params.runId, params.lifecycleGeneration);
  params.respond(true, payload, undefined, { runId: params.runId });
}

/** Release caller authority when admitted work settles. */
export function releaseChatSendCallerAuthority(params: {
  operator: { release?: () => void };
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">;
}): void {
  try {
    params.operator.release?.();
  } finally {
    if (params.request.providerReviewAcknowledgment) {
      retireProviderReviewAcknowledgment(params.request.providerReviewAcknowledgment);
    }
  }
}

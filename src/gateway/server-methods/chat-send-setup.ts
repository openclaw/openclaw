import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import { admitChatSend } from "./chat-send-admission.js";
import {
  respondChatSendAdmissionError,
  runChatSendPreAdmission,
} from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  prepareChatSendNativeRuntimeRestriction,
  prepareChatSendSession,
  qualifyChatSendSession,
  type PreparedChatSendSession,
} from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Normalize, prepare, and exclusively admit one new chat.send request. */
export async function prepareAndAdmitChatSend(
  {
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
  }: Pick<
    GatewayRequestHandlerOptions,
    | "params"
    | "respond"
    | "context"
    | "client"
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
  >,
  onAdmissionOwned?: () => Promise<boolean>,
  options?: {
    trustedSystemInput?: boolean;
    goalResume?: SessionGoalOperation & { action: "resume" };
    providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  },
) {
  const assertCurrent =
    sessionMutationAuthorization || hasCurrentClientAuthority
      ? () => {
          sessionMutationAuthorization?.assertCurrent();
          if (hasCurrentClientAuthority?.() === false) {
            throw new Error("Gateway caller authority is no longer active.");
          }
        }
      : undefined;
  const withCurrent = sessionMutationAuthorization?.withCurrent;
  const assertCurrentAsync = async () =>
    withCurrent ? withCurrent(() => assertCurrent?.()) : assertCurrent?.();
  const normalizedRequest = normalizeChatSendRequest({
    params,
    client,
    ...(options?.trustedSystemInput ? { trustedSystemInput: true } : {}),
    ...(options?.goalResume ? { goalResume: options.goalResume } : {}),
    ...(options?.providerReviewAcknowledgment
      ? { providerReviewAcknowledgment: options.providerReviewAcknowledgment }
      : {}),
  });
  if (!normalizedRequest.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        normalizedRequest.error,
        normalizedRequest.reason ? { details: { reason: normalizedRequest.reason } } : undefined,
      ),
    );
    return undefined;
  }
  const loadedSession = await prepareChatSendSession({
    request: normalizedRequest.value,
    context,
    client,
  });
  if (!loadedSession.ok) {
    respond(
      false,
      undefined,
      typeof loadedSession.error === "string"
        ? errorShape(ErrorCodes.INVALID_REQUEST, loadedSession.error)
        : loadedSession.error,
    );
    return undefined;
  }
  if (normalizedRequest.value.mentions) {
    const mentions = context.mentionInbox?.validateRecipients(
      client,
      loadedSession.value.entry
        ? { sessionKey: loadedSession.value.sessionKey, agentId: loadedSession.value.agentId }
        : { agentId: loadedSession.value.agentId },
      normalizedRequest.value.mentions.map((mention) => mention.profileId),
    );
    if (!mentions?.ok) {
      respond(
        false,
        undefined,
        mentions?.error ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Human mentions are unavailable; reconnect and retry.",
          ),
      );
      return undefined;
    }
  }
  const shouldAdmit = await runChatSendPreAdmission({
    request: normalizedRequest.value,
    session: loadedSession.value,
    respond,
    context,
    client,
    assertCurrent,
    assertCurrentAsync,
    withCurrent,
  });
  if (!shouldAdmit) {
    return undefined;
  }
  let session: PreparedChatSendSession;
  try {
    session = qualifyChatSendSession(loadedSession.value);
  } catch (error) {
    respondChatSendAdmissionError(error, respond);
    return undefined;
  }
  let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
  try {
    const nativeRestriction = await prepareChatSendNativeRuntimeRestriction({
      request: normalizedRequest.value,
      session,
      client,
      context,
      assertCurrent,
      assertCurrentAsync,
    });
    if (nativeRestriction) {
      respond(false, undefined, nativeRestriction);
      return undefined;
    }
    admitted = await admitChatSend({
      request: normalizedRequest.value,
      session,
      respond,
      context,
      client,
      onAdmissionOwned,
      hasCurrentClientAuthority,
      assertCurrent,
      assertCurrentAsync,
      withCurrent,
      withPreparedCurrent: sessionMutationAuthorization?.withPreparedCurrent,
    });
    if (!admitted.ok) {
      return undefined;
    }
    return {
      normalizedRequest,
      preparedSession: { ok: true as const, value: session },
      admitted,
    };
  } finally {
    if (!admitted?.ok) {
      session.releaseSessionTarget();
    }
  }
}

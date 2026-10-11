import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { StoredSessionSuggestion } from "../../config/sessions/session-sharing-store.types.js";
import {
  isSessionWorkStartInvalidatedError,
  SessionWorkStartInvalidatedError,
} from "../../config/sessions/work-start-error.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { handleChatSend } from "./chat-send-handler.js";
import { withSessionMutationCommitGuard } from "./session-mutation-guards.js";
import {
  authorizeSessionSuggestionMutation,
  sessionSuggestionSessionChangedError,
  type createSessionSuggestionMutation,
} from "./sessions-suggestions-access.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
  SessionMutationAuthorization,
} from "./types.js";

export async function dispatchSuggestion(params: {
  context: GatewayRequestContext;
  client: GatewayClient;
  req: Parameters<GatewayRequestHandlers[string]>[0]["req"];
  isWebchatConnect: Parameters<GatewayRequestHandlers[string]>[0]["isWebchatConnect"];
  target: SessionSharingTarget;
  suggestion: StoredSessionSuggestion;
  resolution: "send" | "queue";
  expectedSessionId: string;
  readCurrent: Awaited<ReturnType<typeof createSessionSuggestionMutation>>["readCurrent"];
  signal?: AbortSignal;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}): Promise<{ ok: true } | { ok: false; error: Parameters<RespondFn>[2] }> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.target.canonicalKey,
    agentId: params.target.agentId,
    sessionId: params.expectedSessionId,
    message: params.suggestion.text,
    queueMode: params.resolution === "queue" ? ("followup" as const) : ("steer" as const),
    idempotencyKey: `session-suggestion:${params.suggestion.id}`,
  };
  const captureResponse: RespondFn = (...args) => {
    response = args;
  };
  const { client, suggestion } = params;
  const label = suggestion.authorLabel ?? suggestion.authorId;
  const chatClient: GatewayClient = {
    ...client,
    internal: {
      ...client.internal,
      syntheticClient: true,
      senderAttribution: {
        id: suggestion.authorId,
        identity: { type: "profile", id: suggestion.authorId },
        name: `Suggested by ${label}`,
      },
    },
  };
  const assertRequestCurrent = () => {
    params.signal?.throwIfAborted();
    params.sessionMutationAuthorization?.assertCurrent();
  };
  const assertAdmittedCurrent =
    params.sessionMutationAuthorization?.assertAdmittedInputCurrent ??
    params.sessionMutationAuthorization?.assertCurrent;
  let chatAuthorization: SessionMutationAuthorization | undefined;
  try {
    assertRequestCurrent();
    const current = params.readCurrent();
    if (
      !authorizeSessionSuggestionMutation(
        {
          client: params.client,
          ...current,
          sessionKey: params.target.canonicalKey,
          respond: captureResponse,
        },
        params.resolution,
      )
    ) {
      return { ok: false, error: response?.[2] };
    }
    const authorization = isIncognitoSessionKey(params.target.canonicalKey)
      ? resolveSessionMutationAuthorization({
          client: chatClient,
          method: "chat.send",
          requestParams: chatParams,
          context: params.context,
          expectedTarget: {
            agentId: params.target.agentId,
            sessionKey: params.target.canonicalKey,
            storePath: current.physicalStorePath,
            sessionId: params.expectedSessionId,
          },
        })
      : await withReadySessionRows(
          requireSessionRowProjection(params.context),
          () => [{ key: params.target.canonicalKey, agentId: params.target.agentId }],
          (sessionRowRead) => {
            const row = sessionRowRead.describe({
              key: params.target.canonicalKey,
              agentId: params.target.agentId,
            });
            const rowSourcePath =
              row &&
              (isIncognitoSessionKey(row.key)
                ? row.storeTarget.storePath
                : sessionRowRead.readSource(row)?.path);
            if (!row || rowSourcePath !== current.physicalStorePath) {
              throw new SessionWorkStartInvalidatedError(
                "session source changed before suggestion dispatch",
              );
            }
            return resolveSessionMutationAuthorization({
              client: chatClient,
              method: "chat.send",
              requestParams: chatParams,
              context: params.context,
              sessionRowRead,
              expectedTarget: {
                agentId: params.target.agentId,
                sessionKey: params.target.canonicalKey,
                // Prepared rows retain aliases; the source check above binds the physical store.
                storePath: row.storeTarget.storePath,
                sessionId: params.expectedSessionId,
              },
            });
          },
        );
    assertRequestCurrent();
    if (authorization.error) {
      return { ok: false, error: authorization.error };
    }
    chatAuthorization = withSessionMutationCommitGuard(
      authorization.authorization,
      assertAdmittedCurrent,
      assertRequestCurrent,
    );
    chatAuthorization?.assertCurrent();
  } catch (error) {
    // No chat invocation occurred, so the caller can release its exact claim.
    if (error instanceof SessionMutationAuthorizationChangedError) {
      return { ok: false, error: error.error };
    }
    if (isSessionWorkStartInvalidatedError(error)) {
      return { ok: false, error: sessionSuggestionSessionChangedError(params.target.canonicalKey) };
    }
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "suggestion dispatch authorization failed",
      ),
    };
  }
  await handleChatSend({
    req: { ...params.req, method: "chat.send", params: chatParams },
    params: chatParams,
    client: chatClient,
    isWebchatConnect: params.isWebchatConnect,
    respond: captureResponse,
    sessionMutationAuthorization: chatAuthorization,
    sessionMutationCommitGuard: assertRequestCurrent,
    context: params.context,
  });
  return response?.[0] === true ? { ok: true } : { ok: false, error: response?.[2] };
}

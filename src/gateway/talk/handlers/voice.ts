import {
  ErrorCodes,
  validateTalkVoiceCompleteParams,
  validateTalkVoiceGetParams,
  validateTalkVoiceSetParams,
  type TalkVoiceGetParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { resolveClientVoiceRunBinding } from "../../../talk/client-voice-session.js";
import { resolveRealtimeVoiceSelectionRun } from "../../../talk/voice-selection-control.js";
import { errorShapeFromError } from "../../error-shape.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { captureSessionMutationRouting } from "../../session-sharing-preparation.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { formatForLog } from "../../ws-log.js";
import { assertTalkSessionStorageTarget } from "../session-target.js";
import {
  completeTalkVoiceChange,
  readTalkVoiceSelection,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";

const voiceRequestError = (error: unknown) =>
  errorShapeFromError(ErrorCodes.UNAVAILABLE, error, { message: formatForLog(error) });

function resolveVoiceCaller(options: GatewayRequestHandlerOptions, target: TalkVoiceGetParams) {
  const { client, context } = options;
  const connId = client?.connId;
  if (!client || !connId) {
    throw new Error("Voice selection requires a connected client");
  }
  const authorizeSession = (agentId: string, sessionKey: string) => {
    const authorization = resolveSessionMutationAuthorization({
      client,
      context,
      method: "talk.voice.set",
      requestParams: { agentId, sessionKey },
    });
    if (authorization.error) {
      throw new Error(authorization.error.message);
    }
    return authorization.authorization;
  };
  const identity = client.internal?.agentRuntimeIdentity;
  const binding = identity
    ? resolveClientVoiceRunBinding(identity.operationalRunInstance.runId)
    : undefined;
  const assertCallerCurrent = composeSessionSourceAssertion(
    [
      readGatewayRequestMutationAuthority(options).assertCurrent,
      options.sessionMutationAuthorization?.assertCurrent,
    ],
    (assertSources) => {
      if (client.invalidated || client.connectionSignal?.aborted || options.signal?.aborted) {
        throw new Error("Voice selection caller disconnected");
      }
      assertSources();
      if (
        identity &&
        (context.validateAgentRuntimeApprovalAuthority?.(identity) !== true || !identity.sessionKey)
      ) {
        throw new Error("The agent no longer owns this voice call");
      }
    },
  );
  assertCallerCurrent();
  const managed = identity
    ? resolveRealtimeVoiceSelectionRun(identity.operationalRunInstance.runId)
    : undefined;
  if (managed && identity) {
    if (
      managed.agentId !== identity.agentId ||
      managed.sessionKey !== identity.sessionKey ||
      (target.voiceSessionId && target.voiceSessionId !== managed.voiceSessionId) ||
      (target.sessionKey && target.sessionKey !== managed.sessionKey)
    ) {
      throw new Error("The agent may only select the voice of its own call");
    }
    const authorization = authorizeSession(managed.agentId, managed.sessionKey);
    return {
      kind: "managed" as const,
      managed,
      assertCurrent: () => {
        assertCallerCurrent();
        managed.assertCurrent();
        authorization?.assertCurrent();
      },
    };
  }
  const assertBrowserBindingCurrent = composeSessionSourceAssertion(
    [assertCallerCurrent],
    (assertSource) => {
      assertSource();
      if (
        identity &&
        (!binding ||
          resolveClientVoiceRunBinding(identity.operationalRunInstance.runId) !== binding ||
          binding.agentId !== identity.agentId)
      ) {
        throw new Error("The agent no longer owns this voice call");
      }
    },
  );
  assertBrowserBindingCurrent();
  const session = resolveTalkVoiceSession(
    identity && binding ? { kind: "run", ...binding } : { kind: "client", connId, ...target },
  );
  if (
    identity &&
    identity.sessionKey !== session.sessionTarget.canonicalKey &&
    identity.sessionKey !== session.sessionTarget.sessionKey
  ) {
    throw new Error("The agent may only select the voice of its own chat");
  }
  if (
    identity &&
    ((target.voiceSessionId && target.voiceSessionId !== session.voiceSessionId) ||
      (target.sessionKey &&
        target.sessionKey !== session.sessionTarget.sessionKey &&
        target.sessionKey !== session.sessionTarget.canonicalKey))
  ) {
    throw new Error("The agent may only select the voice of its own call");
  }
  // Resolve the server-owned call before capturing session participation authority.
  assertTalkSessionStorageTarget(context.getRuntimeConfig(), session.sessionTarget);
  const authorization = authorizeSession(
    session.sessionTarget.agentId,
    session.sessionTarget.canonicalKey,
  );
  const assertRoutingCurrent = captureSessionMutationRouting(
    context.getRuntimeConfig(),
    () => new Error("Talk session storage target changed; retry the request"),
    [session.sessionTarget],
  );
  return {
    kind: "browser" as const,
    session,
    connId,
    assertCurrent: composeSessionSourceAssertion(
      [assertBrowserBindingCurrent, authorization?.assertCurrent],
      (assertSources) => {
        assertRoutingCurrent(context.getRuntimeConfig());
        assertSources();
      },
    ),
  };
}

export const talkVoiceHandlers: GatewayRequestHandlers = {
  "talk.voice.get": defineValidatedGatewayHandler(
    "talk.voice.get",
    validateTalkVoiceGetParams,
    async (options) => {
      const { params, respond } = options;
      const caller = resolveVoiceCaller(options, params);
      caller.assertCurrent();
      const selection =
        caller.kind === "managed" ? caller.managed.read() : readTalkVoiceSelection(caller.session);
      respond(true, selection, undefined);
    },
    voiceRequestError,
  ),
  "talk.voice.set": defineValidatedGatewayHandler(
    "talk.voice.set",
    validateTalkVoiceSetParams,
    async (options) => {
      const { params, respond, context } = options;
      const caller = resolveVoiceCaller(options, params);
      const result = await (caller.kind === "managed"
        ? caller.managed.changeVoice(params.voice, {
            assertCurrent: caller.assertCurrent,
            signal: options.signal,
          })
        : requestTalkVoiceChange({
            ...caller,
            voice: params.voice,
            requesterConnId: caller.connId,
            send: (event) =>
              context.broadcastToConnIds(
                "talk.voice.change",
                event,
                new Set([caller.session.connId]),
              ),
          }));
      respond(true, result, undefined);
    },
    voiceRequestError,
  ),
  "talk.voice.complete": defineValidatedGatewayHandler(
    "talk.voice.complete",
    validateTalkVoiceCompleteParams,
    async (options) => {
      const { params, respond, client } = options;
      options.sessionMutationCommitGuard?.();
      options.sessionMutationAuthorization?.assertCurrent();
      if (
        !client?.connId ||
        client.invalidated ||
        client.connectionSignal?.aborted ||
        options.hasCurrentClientAuthority?.() === false ||
        client.internal?.agentRuntimeIdentity
      ) {
        throw new Error("Only the connected voice client can acknowledge a voice change");
      }
      await completeTalkVoiceChange({ ...params, connId: client.connId });
      respond(true, { ok: true }, undefined);
    },
    voiceRequestError,
  ),
};

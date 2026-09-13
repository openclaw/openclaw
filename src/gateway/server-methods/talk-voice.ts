import {
  validateTalkVoiceCompleteParams,
  validateTalkVoiceGetParams,
  validateTalkVoiceSetParams,
  type TalkVoiceGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { assertTalkSessionStorageTarget } from "../talk-session-target.js";
import {
  completeTalkVoiceChange,
  readTalkVoiceSelection,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../talk-voice-selection.js";
import { respondUnavailable } from "./response.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveVoiceCaller(options: GatewayRequestHandlerOptions, target: TalkVoiceGetParams) {
  const { client, context } = options;
  const connId = client?.connId;
  if (!client || !connId) {
    throw new Error("Voice selection requires a connected client");
  }
  const identity = client.internal?.agentRuntimeIdentity;
  const binding = identity
    ? resolveClientVoiceRunBinding(identity.operationalRunInstance.runId)
    : undefined;
  const assertCallerCurrent = () => {
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
    if (
      client.invalidated ||
      client.connectionSignal?.aborted ||
      options.signal?.aborted ||
      options.hasCurrentClientAuthority?.() === false
    ) {
      throw new Error("Voice selection caller disconnected");
    }
    if (
      identity &&
      (context.validateAgentRuntimeApprovalAuthority?.(identity) !== true ||
        !binding ||
        resolveClientVoiceRunBinding(identity.operationalRunInstance.runId) !== binding ||
        binding.agentId !== identity.agentId)
    ) {
      throw new Error("The agent no longer owns this voice call");
    }
  };
  assertCallerCurrent();
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
  const authorization = resolveSessionMutationAuthorization({
    client,
    context,
    method: "talk.voice.set",
    requestParams: {
      agentId: session.sessionTarget.agentId,
      sessionKey: session.sessionTarget.canonicalKey,
    },
  });
  if (authorization.error) {
    throw new Error(authorization.error.message);
  }
  return {
    session,
    connId,
    assertCurrent: () => {
      assertCallerCurrent();
      assertTalkSessionStorageTarget(context.getRuntimeConfig(), session.sessionTarget);
      authorization.authorization?.assertCurrent();
    },
  };
}

export const talkVoiceHandlers: GatewayRequestHandlers = {
  "talk.voice.get": async (options) => {
    const { params, respond } = options;
    if (!assertValidParams(params, validateTalkVoiceGetParams, "talk.voice.get", respond)) {
      return;
    }
    try {
      const caller = resolveVoiceCaller(options, params);
      caller.assertCurrent();
      respond(true, readTalkVoiceSelection(caller.session), undefined);
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },
  "talk.voice.set": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateTalkVoiceSetParams, "talk.voice.set", respond)) {
      return;
    }
    try {
      const caller = resolveVoiceCaller(options, params);
      const result = await requestTalkVoiceChange({
        ...caller,
        voice: params.voice,
        requesterConnId: caller.connId,
        send: (event) =>
          context.broadcastToConnIds("talk.voice.change", event, new Set([caller.session.connId])),
      });
      respond(true, result, undefined);
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },
  "talk.voice.complete": async (options) => {
    const { params, respond, client } = options;
    if (
      !assertValidParams(params, validateTalkVoiceCompleteParams, "talk.voice.complete", respond)
    ) {
      return;
    }
    try {
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
    } catch (error) {
      respondUnavailable(respond, error);
    }
  },
};

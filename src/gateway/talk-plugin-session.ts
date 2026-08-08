import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  PLUGIN_TALK_AUDIO_FORMAT,
  type OpenPluginTalkSessionParams,
  type PluginTalkSession,
  type PluginTalkSessionEvent,
} from "../talk/plugin-session.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { TalkRealtimeRelayEvent } from "./talk-realtime-relay-state.js";
import {
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";
import { createGatewayRealtimeTalkSession } from "./talk-realtime-session-create.js";

const PCM16_24KHZ_MONO_BYTES_PER_MS = 48;

function requirePluginTalkScope() {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.context || !scope.pluginId || scope.gatewayMethodDispatchAllowed !== true) {
    throw new Error(
      "Interactive Talk sessions require a plugin request route that declares the gatewayMethodDispatch contract.",
    );
  }
  const operatorScopes = scope.client?.connect.scopes ?? [];
  if (!authorizeOperatorScopesForMethod("talk.session.create", operatorScopes).allowed) {
    throw new Error(
      "Interactive Talk sessions require an authenticated plugin request with Talk access.",
    );
  }
  return { context: scope.context, pluginId: scope.pluginId };
}

function createPluginTalkEventSink(
  params: OpenPluginTalkSessionParams,
  onDeliveryError: (error: unknown) => void,
) {
  let generation = 0;
  let sequence = 0;
  let ptsMs = 0;
  let state: Extract<PluginTalkSessionEvent, { type: "state" }>["state"] = "idle";
  let closed = false;

  const deliver = (event: PluginTalkSessionEvent): void => {
    try {
      void Promise.resolve(params.onEvent(event)).catch(onDeliveryError);
    } catch (error) {
      onDeliveryError(error);
    }
  };
  const setState = (next: typeof state): void => {
    if (state === next || closed) {
      return;
    }
    state = next;
    deliver({ type: "state", generation, ptsMs, state });
  };

  return {
    get closed() {
      return closed;
    },
    eventSink(event: TalkRealtimeRelayEvent): void {
      switch (event.type) {
        case "ready":
        case "inputAudio":
        case "audioDone":
          setState("listening");
          return;
        case "audioStarted":
          setState("speaking");
          return;
        case "audio": {
          setState("speaking");
          const pcm = Buffer.from(event.audioBase64, "base64");
          deliver({ type: "audio", generation, sequence, ptsMs, pcm });
          sequence += 1;
          ptsMs += pcm.byteLength / PCM16_24KHZ_MONO_BYTES_PER_MS;
          return;
        }
        case "transcript":
          if (event.role === "user" && event.final && event.text.trim()) {
            setState("thinking");
          }
          return;
        case "toolCall":
          setState("thinking");
          return;
        case "clear":
          generation += 1;
          sequence = 0;
          ptsMs = 0;
          deliver({
            type: "clear",
            generation,
            reason: event.reason === "barge-in" ? "barge-in" : "cancel",
          });
          setState("listening");
          return;
        case "error":
          setState("error");
          return;
        case "close":
          if (closed) {
            return;
          }
          closed = true;
          deliver({ type: "closed", generation, reason: event.reason });
          break;
        case "mark":
        case "toolCallCancelled":
        case "toolProgress":
        case "toolResult":
          break;
      }
    },
  };
}

export async function openPluginTalkSession(
  params: OpenPluginTalkSessionParams,
): Promise<PluginTalkSession> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error(
      "Choose an OpenClaw session before starting voice so the conversation uses the intended agent and workspace.",
    );
  }
  const { context, pluginId } = requirePluginTalkScope();
  const ownerId = `plugin:${pluginId}:${randomUUID()}`;
  const lifecycle: { relaySessionId?: string } = {};
  let deliveryError: unknown;
  const events = createPluginTalkEventSink(params, (error) => {
    deliveryError ??= error;
    context.logGateway.warn(`plugin Talk event delivery failed: ${formatErrorMessage(error)}`);
    if (lifecycle.relaySessionId && !events.closed) {
      try {
        stopTalkRealtimeRelaySession({ relaySessionId: lifecycle.relaySessionId, connId: ownerId });
      } catch (closeError) {
        context.logGateway.warn(
          `plugin Talk session cleanup failed: ${formatErrorMessage(closeError)}`,
        );
      }
    }
  });
  const session = await createGatewayRealtimeTalkSession({
    context,
    ownerId,
    request: {
      sessionKey,
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.voice ? { voice: params.voice } : {}),
      ...(params.language ? { language: params.language } : {}),
    },
    eventSink: events.eventSink,
  });
  lifecycle.relaySessionId = session.relaySessionId;
  if (deliveryError) {
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: ownerId });
    throw deliveryError;
  }

  return {
    audio: PLUGIN_TALK_AUDIO_FORMAT,
    sendAudio(pcm, options) {
      if (events.closed) {
        throw new Error("Talk session is closed");
      }
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: ownerId,
        audioBase64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
        timestamp: options?.timestamp,
      });
    },
    cancelOutput(reason) {
      if (events.closed) {
        return;
      }
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: ownerId,
        reason: reason?.trim() || "plugin-cancelled",
      });
    },
    close() {
      if (events.closed) {
        return;
      }
      stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: ownerId });
    },
  };
}

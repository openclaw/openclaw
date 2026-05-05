import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
} from "../realtime-voice/provider-types.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
} from "../realtime-voice/session-runtime.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.realtime.relay";
const log = createSubsystemLogger("gateway").child("talk-realtime-relay");

type TalkRealtimeRelayEvent =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "audio"; audioBase64: string }
  | { relaySessionId: string; type: "clear" }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
    }
  | {
      relaySessionId: string;
      type: "error";
      category: RealtimeRelayErrorCategory;
      hard: boolean;
      message: string;
    }
  | {
      relaySessionId: string;
      type: "paused";
      category: RealtimeRelayErrorCategory;
      reason: "provider_hard_error";
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

export type RealtimeRelayErrorCategory = "quota" | "auth" | "provider_unavailable" | "unknown";

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
};

type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

const relaySessions = new Map<string, RelaySession>();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyRealtimeRelayError(error: unknown): RealtimeRelayErrorCategory {
  const message = formatError(error).toLowerCase();
  if (
    /\b(insufficient[_ -]?quota|quota|billing|credits?|payment|required plan|usage limit)\b/.test(
      message,
    )
  ) {
    return "quota";
  }
  if (
    /\b(auth|authentication|unauthorized|forbidden|permission|api key|apikey|invalid key|401|403)\b/.test(
      message,
    )
  ) {
    return "auth";
  }
  if (
    /\b(unavailable|overloaded|temporarily unavailable|service unavailable|timeout|timed out|econnreset|econnrefused|503|502|504)\b/.test(
      message,
    )
  ) {
    return "provider_unavailable";
  }
  return "unknown";
}

function sanitizedRelayErrorMessage(category: RealtimeRelayErrorCategory): string {
  switch (category) {
    case "quota":
      return "realtime provider quota or billing error";
    case "auth":
      return "realtime provider authentication error";
    case "provider_unavailable":
      return "realtime provider unavailable";
    case "unknown":
      return "realtime provider error";
  }
}

function emitHardRelayError(
  emit: (event: TalkRealtimeRelayEvent) => void,
  relaySessionId: string,
  error: unknown,
): void {
  const category = classifyRealtimeRelayError(error);
  emit({
    relaySessionId,
    type: "error",
    category,
    hard: true,
    message: sanitizedRelayErrorMessage(category),
  });
  emit({ relaySessionId, type: "paused", category, reason: "provider_hard_error" });
}

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), { dropIfSlow: true });
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  relaySessions.delete(session.id);
  clearTimeout(session.cleanupTimer);
  session.bridge.close();
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
  });
}

function pruneExpiredRelaySessions(nowMs = Date.now()): void {
  for (const session of relaySessions.values()) {
    if (nowMs > session.expiresAtMs) {
      closeRelaySession(session, "completed");
    }
  }
}

function countRelaySessionsForConn(connId: string): number {
  let count = 0;
  for (const session of relaySessions.values()) {
    if (session.connId === connId) {
      count += 1;
    }
  }
  return count;
}

function enforceRelaySessionLimits(connId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const relaySessionId = randomUUID();
  const expiresAtMs = Date.now() + RELAY_SESSION_TTL_MS;
  let relay: RelaySession | undefined;
  const emit = (event: TalkRealtimeRelayEvent) =>
    broadcastToOwner(params.context, params.connId, event);
  const bridge = createRealtimeVoiceBridgeSession({
    provider: params.provider,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    tools: params.tools,
    markStrategy: "transport",
    audioSink: {
      isOpen: () => Boolean(relay && relaySessions.has(relay.id)),
      sendAudio: (audio) => {
        log.info(`relay output audio session=${relaySessionId.slice(0, 8)} bytes=${audio.length}`);
        emit({
          relaySessionId,
          type: "audio",
          audioBase64: audio.toString("base64"),
        });
      },
      clearAudio: () => {
        log.info(`relay output clear session=${relaySessionId.slice(0, 8)}`);
        emit({ relaySessionId, type: "clear" });
      },
      sendMark: (markName) => emit({ relaySessionId, type: "mark", markName }),
    },
    onTranscript: (role, text, final) => {
      log.info(
        `relay transcript session=${relaySessionId.slice(0, 8)} role=${role} final=${final} chars=${text.length}`,
      );
      emit({ relaySessionId, type: "transcript", role, text, final });
    },
    onToolCall: (toolCall) => {
      emit({
        relaySessionId,
        type: "toolCall",
        itemId: toolCall.itemId,
        callId: toolCall.callId,
        name: toolCall.name,
        args: toolCall.args,
      });
    },
    onReady: () => {
      log.info(`relay ready session=${relaySessionId.slice(0, 8)} provider=${params.provider.id}`);
      emit({ relaySessionId, type: "ready" });
    },
    onError: (error) => {
      const category = classifyRealtimeRelayError(error);
      log.warn(`relay error session=${relaySessionId.slice(0, 8)} category=${category}`);
      emitHardRelayError(emit, relaySessionId, error);
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "error");
      }
    },
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      relaySessions.delete(relaySessionId);
      clearTimeout(active.cleanupTimer);
      emit({ relaySessionId, type: "close", reason });
    },
  });
  relay = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
  };
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  bridge.connect().catch((error: unknown) => {
    const category = classifyRealtimeRelayError(error);
    log.warn(`relay connect error session=${relaySessionId.slice(0, 8)} category=${category}`);
    emitHardRelayError(emit, relaySessionId, error);
    const active = relaySessions.get(relaySessionId);
    if (active) {
      closeRelaySession(active, "error");
    }
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  const session = relaySessions.get(relaySessionId);
  if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
    log.warn(
      `relay session lookup failed session=${relaySessionId.slice(0, 8)} reason=${
        !session ? "missing" : session.connId !== connId ? "conn_mismatch" : "expired"
      }`,
    );
    if (session) {
      closeRelaySession(session, "completed");
    }
    throw new Error("Unknown realtime relay session");
  }
  return session;
}

export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  const audio = Buffer.from(params.audioBase64, "base64");
  if (Math.random() < 0.02) {
    log.info(
      `relay input audio accepted session=${params.relaySessionId.slice(0, 8)} bytes=${audio.length}`,
    );
  }
  session.bridge.sendAudio(audio);
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

export function acknowledgeTalkRealtimeRelayMark(params: {
  relaySessionId: string;
  connId: string;
}): void {
  getRelaySession(params.relaySessionId, params.connId).bridge.acknowledgeMark();
}

export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
}): void {
  getRelaySession(params.relaySessionId, params.connId).bridge.submitToolResult(
    params.callId,
    params.result,
  );
}

export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(session, "completed");
}

export function clearTalkRealtimeRelaySessionsForTest(): void {
  for (const session of relaySessions.values()) {
    clearTimeout(session.cleanupTimer);
    session.bridge.close();
  }
  relaySessions.clear();
}

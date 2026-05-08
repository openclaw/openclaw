import { randomUUID } from "node:crypto";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceFinalizeAudioInputResult,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
} from "../talk/provider-types.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
} from "../talk/session-runtime.js";
import {
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
  createTalkSessionController,
} from "../talk/talk-session-controller.js";
import { abortChatRunById } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_DOWNLINK_AUDIO_BYTES = 20 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_COMMIT_NO_OUTPUT_TIMEOUT_MS = 2500;
const RELAY_EVENT = "talk.event";

type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | { relaySessionId: string; type: "audio"; audioBase64: string }
  | { relaySessionId: string; type: "clear" }
  | { relaySessionId: string; type: "idle"; reason: "no_response" | "unsupported" | "no_input" }
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
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | {
      relaySessionId: string;
      type: "error";
      category?: RealtimeRelayErrorCategory;
      hard?: boolean;
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

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  talk: TalkSessionController;
  expiresAtMs: number;
  acceptedAudioBytes: number;
  outputEventCount: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
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

export function sanitizedRelayErrorMessage(category: RealtimeRelayErrorCategory): string {
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

function emitRelayError(
  emit: (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) => void,
  relaySessionId: string,
  error: unknown,
  hard = false,
): void {
  const category = classifyRealtimeRelayError(error);
  const message = sanitizedRelayErrorMessage(category);
  emit(
    { relaySessionId, type: "error", category, hard, message },
    { type: "session.error", payload: { message }, final: hard },
  );
  if (hard) {
    emit({ relaySessionId, type: "paused", category, reason: "provider_hard_error" });
  }
}

function emitAudioChunks(
  emit: (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) => void,
  relaySessionId: string,
  audio: Buffer,
  turnId: string | undefined,
): void {
  for (let offset = 0; offset < audio.length; offset += MAX_RELAY_DOWNLINK_AUDIO_BYTES) {
    const chunk = audio.subarray(offset, offset + MAX_RELAY_DOWNLINK_AUDIO_BYTES);
    emit(
      { relaySessionId, type: "audio", audioBase64: chunk.toString("base64") },
      { type: "output.audio.delta", turnId, payload: { byteLength: chunk.length } },
    );
  }
}

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), { dropIfSlow: true });
}

function abortRelayAgentRuns(session: RelaySession, reason: string): void {
  for (const [runId, sessionKey] of session.activeAgentRuns) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: reason,
    });
  }
  session.activeAgentRuns.clear();
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  relaySessions.delete(session.id);
  clearTimeout(session.cleanupTimer);
  abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  session.bridge.close();
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.talk.emit({
      type: "session.closed",
      payload: { reason },
      final: true,
    }),
  });
}

function scheduleCommitNoOutputFallback(
  session: RelaySession,
  outputEventCountAtCommit: number,
): void {
  const timer = setTimeout(() => {
    const active = relaySessions.get(session.id);
    if (!active || active.outputEventCount !== outputEventCountAtCommit) {
      return;
    }
    broadcastToOwner(active.context, active.connId, {
      relaySessionId: active.id,
      type: "idle",
      reason: "no_response",
    });
  }, RELAY_COMMIT_NO_OUTPUT_TIMEOUT_MS);
  timer.unref?.();
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
  const talk = createTalkSessionController(
    {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  let relay: RelaySession | undefined;
  const emit = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) => {
    if (
      relay &&
      (event.type === "audio" ||
        event.type === "clear" ||
        event.type === "transcript" ||
        event.type === "toolCall" ||
        event.type === "idle" ||
        event.type === "error")
    ) {
      relay.outputEventCount += 1;
    }
    broadcastToOwner(params.context, params.connId, {
      ...event,
      ...(talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}),
    });
  };
  const bridge = createRealtimeVoiceBridgeSession({
    provider: params.provider,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    tools: params.tools,
    markStrategy: "ack-immediately",
    audioSink: {
      isOpen: () => Boolean(relay && relaySessions.has(relay.id)),
      sendAudio: (audio) => {
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
        emitAudioChunks(emit, relaySessionId, audio, turnId);
      },
      clearAudio: () => {
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
        emit(
          { relaySessionId, type: "clear" },
          {
            type: "output.audio.done",
            turnId,
            payload: { reason: "clear" },
            final: true,
          },
        );
      },
      sendMark: (markName) => {
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
        emit(
          { relaySessionId, type: "mark", markName },
          {
            type: "output.audio.done",
            turnId,
            payload: { markName },
            final: true,
          },
        );
      },
    },
    onTranscript: (role, text, final) => {
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(
        { relaySessionId, type: "transcript", role, text, final },
        {
          type: eventType,
          turnId,
          payload,
          final,
        },
      );
    },
    onToolCall: (toolCall) => {
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
    },
    onReady: () =>
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null }),
    onError: (error) => emitRelayError(emit, relaySessionId, error, true),
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      relaySessions.delete(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      emit(
        { relaySessionId, type: "close", reason },
        { type: "session.closed", payload: { reason }, final: true },
      );
    },
  });
  relay = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    talk,
    expiresAtMs,
    acceptedAudioBytes: 0,
    outputEventCount: 0,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
  };
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  bridge.connect().catch((error: unknown) => {
    emitRelayError(emit, relaySessionId, error, true);
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

function ensureRelayTurn(session: RelaySession): string {
  const turn = session.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  const session = relaySessions.get(relaySessionId);
  if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
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
  const turnId = ensureRelayTurn(session);
  const audio = Buffer.from(params.audioBase64, "base64");
  session.acceptedAudioBytes += audio.length;
  session.bridge.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
  });
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.bridge.submitToolResult(params.callId, params.result);
  const turnId = ensureRelayTurn(session);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId,
      payload: { result: params.result },
      final: true,
    }),
  });
}

export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.activeAgentRuns.set(params.runId, params.sessionKey);
}

export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = ensureRelayTurn(session);
  const reason = params.reason ?? "client-cancelled";
  session.bridge.handleBargeIn({ audioPlaybackActive: true });
  abortRelayAgentRuns(session, reason);
  const cancelled = session.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

export async function finalizeTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
}): Promise<RealtimeVoiceFinalizeAudioInputResult | void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = ensureRelayTurn(session);
  if (session.acceptedAudioBytes <= 0) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "idle",
      reason: "no_input",
      talkEvent: session.talk.emit({
        type: "input.audio.committed",
        turnId,
        payload: { status: "no_input" },
        final: true,
      }),
    });
    return { status: "idle" };
  }
  const supportsFinalize = typeof session.bridge.bridge.finalizeAudioInput === "function";
  if (!supportsFinalize) {
    session.acceptedAudioBytes = 0;
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "idle",
      reason: "unsupported",
      talkEvent: session.talk.emit({
        type: "input.audio.committed",
        turnId,
        payload: { status: "unsupported" },
        final: true,
      }),
    });
    return { status: "idle" };
  }
  const outputEventCountAtCommit = session.outputEventCount;
  let result: RealtimeVoiceFinalizeAudioInputResult | void;
  try {
    result = await session.bridge.finalizeAudioInput();
  } catch (error) {
    emitRelayError(
      (event, talkEvent) =>
        broadcastToOwner(session.context, session.connId, {
          ...event,
          ...(talkEvent ? { talkEvent: session.talk.emit(talkEvent) } : {}),
        }),
      session.id,
      error,
    );
    throw new Error(sanitizedRelayErrorMessage(classifyRealtimeRelayError(error)));
  }
  const status = result && typeof result === "object" ? result.status : undefined;
  session.acceptedAudioBytes = 0;
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: 0,
    talkEvent: session.talk.emit({
      type: "input.audio.committed",
      turnId,
      payload: { status: status ?? "committed" },
      final: true,
    }),
  });
  if (status === "idle" || status === "no_response") {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "idle",
      reason: "no_response",
    });
    return result;
  }
  scheduleCommitNoOutputFallback(session, outputEventCountAtCommit);
  return result;
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

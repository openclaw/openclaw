import { randomUUID } from "node:crypto";
import {
  parseFiniteNumber as readFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { recordTalkObservabilityEvent } from "../../talk/observability.js";
import {
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
  createTalkSessionController,
} from "../../talk/talk-session-controller.js";
import type { GatewayRequestContext } from "../server-methods/shared-types.js";
import { decodeTalkRelayAudioBase64 } from "./relay-audio-base64.js";
import {
  assertTalkRelaySessionCapacity,
  closeExpiredTalkRelaySessions,
  closeTalkRelaySessionsForConnection,
  requireActiveTalkRelaySession,
} from "./relay-session-lifecycle.js";
import { forgetUnifiedTalkSession, registerTalkConnectionCleanup } from "./session-registry.js";

const TRANSCRIPTION_SESSION_TTL_MS = 30 * 60 * 1000;
// Realtime transcription websocket owners retain provider sockets for this
// bounded interval so a graceful close can still deliver its final transcript.
const TRANSCRIPTION_PROVIDER_FINAL_DRAIN_MS = 5_000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const TRANSCRIPTION_EVENT = "talk.event";
const RELAY_INPUT_ENCODING = "g711_ulaw";
const RELAY_INPUT_SAMPLE_RATE_HZ = 8000;

type TalkTranscriptionRelayEventPayload =
  | { type: "ready" }
  | { type: "inputAudio"; byteLength: number }
  | { type: "partial"; text: string }
  | { type: "transcript"; text: string; final: true }
  | { type: "speechStart" }
  | { type: "error"; message: string }
  | { type: "close"; reason: "completed" | "error" };

type TalkTranscriptionRelayEvent = TalkTranscriptionRelayEventPayload & {
  talkEvent?: TalkEvent;
};

type TranscriptionRelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  sttSession: ReturnType<RealtimeTranscriptionProviderPlugin["createSession"]>;
  talk: TalkSessionController;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  receivedAudio: boolean;
  draining: boolean;
};

type CreateTalkTranscriptionRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

const transcriptionSessions = new Map<string, TranscriptionRelaySession>();

/** Verifies provider config matches the audio format the browser relay emits. */
function assertRelayInputAudioConfig(providerConfig: RealtimeTranscriptionProviderConfig): void {
  const encodingValue =
    providerConfig.encoding ?? providerConfig.audioFormat ?? providerConfig.audio_format;
  // Unknown provider aliases remain provider-owned; reject only known incompatible formats.
  const encoding = typeof encodingValue === "string" ? encodingValue.trim().toLowerCase() : "";
  if (
    [
      "alaw",
      "g711_alaw",
      "g711-alaw",
      "pcm_alaw",
      "pcm",
      "pcm16",
      "linear16",
      "pcm_s16le",
    ].includes(encoding)
  ) {
    throw new Error(
      `Gateway transcription relay requires ${RELAY_INPUT_ENCODING}/${RELAY_INPUT_SAMPLE_RATE_HZ} audio`,
    );
  }

  const sampleRate =
    readFiniteNumber(providerConfig.sampleRate ?? providerConfig.sample_rate) ??
    (typeof encodingValue === "string"
      ? readFiniteNumber(encodingValue.match(/_(\d+)$/)?.[1])
      : undefined);
  if (sampleRate && sampleRate !== RELAY_INPUT_SAMPLE_RATE_HZ) {
    throw new Error(
      `Gateway transcription relay requires ${RELAY_INPUT_ENCODING}/${RELAY_INPUT_SAMPLE_RATE_HZ} audio`,
    );
  }
}

function broadcastToOwner(
  session: Pick<TranscriptionRelaySession, "id" | "context" | "connId" | "talk">,
  event: TalkTranscriptionRelayEvent,
  talkEvent?: TalkEventInput,
): void {
  session.context.broadcastToConnIds(
    TRANSCRIPTION_EVENT,
    {
      transcriptionSessionId: session.id,
      ...event,
      ...(talkEvent ? { talkEvent: session.talk.emit(talkEvent) } : {}),
    },
    new Set([session.connId]),
    { dropIfSlow: event.type === "inputAudio" || event.type === "partial" },
  );
}

function ensureTranscriptionTurn(session: TranscriptionRelaySession): string {
  const turn = session.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session, {
      type: "speechStart",
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}

function closeTranscriptionSession(
  session: TranscriptionRelaySession,
  reason: "completed" | "error",
): void {
  if (transcriptionSessions.get(session.id) !== session) {
    return;
  }
  transcriptionSessions.delete(session.id);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  try {
    if (!session.draining) {
      session.sttSession.close();
    }
  } finally {
    // Provider teardown may throw, but the owner-visible terminal event must
    // still complete so disconnect cleanup cannot leave ambiguous state.
    broadcastToOwner(session, {
      type: "close",
      reason,
      talkEvent: session.talk.emit({
        type: "session.closed",
        payload: { reason },
        final: true,
      }),
    });
  }
}

/** Releases every transcription relay owned by a disconnected gateway connection. */
function closeTalkTranscriptionRelaySessionsForConnection(connId: string): Promise<void> {
  return closeTalkRelaySessionsForConnection({
    sessions: transcriptionSessions.values(),
    connId,
    closeSession: (session) => closeTranscriptionSession(session, "completed"),
    onCloseError: (error, session) => {
      session.context.logGateway.warn(
        `failed to close transcription relay session after connection disconnect: ${formatError(error)}`,
      );
    },
  });
}

function enforceTranscriptionSessionLimits(connId: string): void {
  closeExpiredTalkRelaySessions({
    sessions: transcriptionSessions.values(),
    closeSession: (session) => closeTranscriptionSession(session, "completed"),
  });
  assertTalkRelaySessionCapacity([...transcriptionSessions.values()], connId, "transcription Talk");
}

/** Creates a transcription relay session and returns its browser audio contract. */
export function createTalkTranscriptionRelaySession(
  params: CreateTalkTranscriptionRelaySessionParams,
) {
  enforceTranscriptionSessionLimits(params.connId);
  assertRelayInputAudioConfig(params.providerConfig);
  const transcriptionSessionId = randomUUID();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(TRANSCRIPTION_SESSION_TTL_MS);
  if (expiresAtMs === undefined) {
    throw new Error("Transcription relay session expiry is outside the supported Date range");
  }
  const talk = createTalkSessionController(
    {
      sessionId: transcriptionSessionId,
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      provider: params.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const eventOwner = {
    id: transcriptionSessionId,
    context: params.context,
    connId: params.connId,
    talk,
  };
  const emit = (event: TalkTranscriptionRelayEvent, talkEvent?: TalkEventInput) =>
    broadcastToOwner(eventOwner, event, talkEvent);
  const relayRef: { current?: TranscriptionRelaySession } = {};
  const getActiveRelay = (): TranscriptionRelaySession | undefined => {
    const relay = relayRef.current;
    return relay && transcriptionSessions.get(relay.id) === relay ? relay : undefined;
  };
  const onTranscript = (text: string, final: boolean) => {
    const relay = getActiveRelay();
    if (!relay) {
      return;
    }
    const turnId = ensureTranscriptionTurn(relay);
    emit(final ? { type: "transcript", text, final: true } : { type: "partial", text }, {
      type: final ? "transcript.done" : "transcript.delta",
      turnId,
      payload: { text },
      ...(final ? { final: true } : {}),
    });
    if (final) {
      const ended = relay.talk.endTurn({ turnId, payload: {} });
      if (ended.ok) {
        emit({
          type: "transcript",
          text: "",
          final: true,
          talkEvent: ended.event,
        });
      }
    }
  };
  const failRelay = (relay: TranscriptionRelaySession, message: string) => {
    emit({ type: "error", message }, { type: "session.error", payload: { message }, final: true });
    closeTranscriptionSession(relay, "error");
  };
  const sttSession = params.provider.createSession({
    cfg: params.context.getRuntimeConfig(),
    providerConfig: params.providerConfig,
    onSpeechStart: () => {
      const relay = getActiveRelay();
      if (!relay || relay.draining) {
        return;
      }
      ensureTranscriptionTurn(relay);
    },
    onPartial: (text) => onTranscript(text, false),
    onTranscript: (text) => onTranscript(text, true),
    onError: (error) => {
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      failRelay(relay, error.message);
    },
  });
  const relay: TranscriptionRelaySession = {
    id: transcriptionSessionId,
    connId: params.connId,
    context: params.context,
    sttSession,
    talk,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = transcriptionSessions.get(transcriptionSessionId);
      if (active) {
        closeTranscriptionSession(active, "completed");
      }
    }, TRANSCRIPTION_SESSION_TTL_MS),
    receivedAudio: false,
    draining: false,
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  transcriptionSessions.set(transcriptionSessionId, relay);
  registerTalkConnectionCleanup(params.connId, "transcription-relay", () =>
    closeTalkTranscriptionRelaySessionsForConnection(params.connId),
  );
  sttSession
    .connect()
    .then(() => {
      if (transcriptionSessions.get(transcriptionSessionId) !== relay || relay.draining) {
        return;
      }
      emit({ type: "ready" }, { type: "session.ready", payload: null });
    })
    .catch((error: unknown) => {
      const active = transcriptionSessions.get(transcriptionSessionId);
      if (active !== relay) {
        return;
      }
      failRelay(active, error instanceof Error ? error.message : String(error));
    });

  return {
    provider: params.provider.id,
    mode: "transcription" as const,
    transport: "gateway-relay" as const,
    transcriptionSessionId,
    audio: {
      inputEncoding: RELAY_INPUT_ENCODING,
      inputSampleRateHz: RELAY_INPUT_SAMPLE_RATE_HZ,
    } as const,
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function getTranscriptionSession(
  transcriptionSessionId: string,
  connId: string,
): TranscriptionRelaySession {
  const relay = requireActiveTalkRelaySession({
    sessions: transcriptionSessions,
    sessionId: transcriptionSessionId,
    connId,
    closeSession: (session) => closeTranscriptionSession(session, "completed"),
    unknownSessionMessage: "Unknown transcription Talk session",
  });
  if (relay.draining) {
    throw new Error("Unknown transcription Talk session");
  }
  return relay;
}

/** Streams one base64-encoded audio frame into the owning transcription relay. */
export function sendTalkTranscriptionRelayAudio(params: {
  transcriptionSessionId: string;
  connId: string;
  audioBase64: string;
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Transcription Talk audio frame is too large");
  }
  const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Transcription Talk");
  const turnId = ensureTranscriptionTurn(session);
  session.sttSession.sendAudio(audio);
  session.receivedAudio = true;
  broadcastToOwner(session, {
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
  });
}

/** Commits the current transcription turn and closes the relay. */
export function stopTalkTranscriptionRelaySession(params: {
  transcriptionSessionId: string;
  connId: string;
}): void {
  const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
  const turnId = session.talk.activeTurnId;
  if (!turnId && !session.receivedAudio) {
    closeTranscriptionSession(session, "completed");
    return;
  }
  if (turnId) {
    broadcastToOwner(session, {
      type: "transcript",
      text: "",
      final: true,
      talkEvent: session.talk.emit({
        type: "input.audio.committed",
        turnId,
        payload: {},
        final: true,
      }),
    });
  }
  session.draining = true;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (transcriptionSessions.get(session.id) === session) {
      closeTranscriptionSession(session, "completed");
    }
  }, TRANSCRIPTION_PROVIDER_FINAL_DRAIN_MS);
  session.cleanupTimer.unref?.();
  try {
    // Providers can flush several finals across asynchronous frames; keep this
    // exact owner registered throughout its bounded provider shutdown window.
    session.sttSession.close();
  } catch (error) {
    closeTranscriptionSession(session, "completed");
    throw error;
  }
}

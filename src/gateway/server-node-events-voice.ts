import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createDeferredCore } from "../shared/deferred.js";

const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
type VoiceTranscriptReservationAdmission = { work: Promise<unknown> } | null;
type VoiceTranscriptReservation = {
  fingerprint: string;
  receivedAt: number;
  status: "pending" | "ready" | "checking" | "rejected";
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  start?: () => Promise<unknown>;
  resolve: (admission: VoiceTranscriptReservationAdmission) => void;
  rejectDecision: (reason: unknown) => void;
  decision: Promise<VoiceTranscriptReservationAdmission>;
};
const pendingVoiceTranscriptReservations = new Map<string, VoiceTranscriptReservation[]>();

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function resolveVoiceTranscriptFingerprint(
  obj: Record<string, unknown>,
  text: string,
): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  // Voice providers can replay identical transcript fragments during reconnect.
  // Keep only a bounded last fingerprint per session to avoid duplicate sends.
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    pruneMapToMaxSize(recentVoiceTranscripts, MAX_RECENT_VOICE_TRANSCRIPTS);
  }

  return false;
}

export function reserveVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  receivedAt: number;
}): {
  admit: (params: {
    isConnectionCurrent?: () => boolean | Promise<boolean>;
    start: () => Promise<unknown>;
  }) => Promise<VoiceTranscriptReservationAdmission>;
  reject: () => void;
} {
  // Resolve reservations in receipt order so delayed currentness checks cannot
  // change the dedupe window, while rejected connections leave no committed state.
  const decision = createDeferredCore<VoiceTranscriptReservationAdmission>();
  const reservation: VoiceTranscriptReservation = {
    fingerprint: params.fingerprint,
    receivedAt: params.receivedAt,
    status: "pending",
    resolve: decision.resolve,
    rejectDecision: decision.reject,
    decision: decision.promise,
  };
  const queue = pendingVoiceTranscriptReservations.get(params.sessionKey) ?? [];
  queue.push(reservation);
  pendingVoiceTranscriptReservations.set(params.sessionKey, queue);

  const drain = () => {
    while (queue[0]?.status === "rejected") {
      const next = queue.shift();
      if (!next) {
        break;
      }
      next.resolve(null);
    }
    const next = queue[0];
    if (!next) {
      pendingVoiceTranscriptReservations.delete(params.sessionKey);
      return;
    }
    if (next.status !== "ready") {
      return;
    }
    next.status = "checking";
    void (async () => {
      try {
        const isCurrent = next.isConnectionCurrent ? await next.isConnectionCurrent() : true;
        const admission =
          isCurrent &&
          !shouldDropDuplicateVoiceTranscript({
            sessionKey: params.sessionKey,
            fingerprint: next.fingerprint,
            now: next.receivedAt,
          }) &&
          next.start
            ? { work: next.start() }
            : null;
        queue.shift();
        next.resolve(admission);
      } catch (err) {
        queue.shift();
        next.rejectDecision(err);
      }
      drain();
    })();
  };
  const settle = (status: "ready" | "rejected") => {
    if (reservation.status !== "pending") {
      return;
    }
    reservation.status = status;
    drain();
  };

  return {
    admit: ({ isConnectionCurrent, start }) => {
      reservation.isConnectionCurrent = isConnectionCurrent;
      reservation.start = start;
      settle("ready");
      return reservation.decision;
    },
    reject: () => settle("rejected"),
  };
}

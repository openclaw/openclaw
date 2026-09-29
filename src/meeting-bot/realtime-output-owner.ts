import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type { RealtimeVoiceBridgeEvent } from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

const STALE_RESPONSE_LIMIT = 16;
const AUDIO_DELTA_EVENTS = new Set([
  "conversation.output_audio.delta",
  "response.audio.delta",
  "response.output_audio.delta",
]);
const OUTPUT_MAX_PENDING_MS = 2_000;
const OUTPUT_MAX_WRITE_MS = 500;
const OUTPUT_MAX_PENDING_FRAMES = 256;
const OUTPUT_MAX_PREPARED_MS = 120_000;

type PreparedOutput = {
  token: symbol;
  generation: number;
  completion?: Deferred;
  assertCurrent?: () => void;
  refreshCurrent?: () => Promise<void>;
  onStarted?: () => void;
  refreshed: boolean;
};

/** Serializes native playback writes and fences queued audio across interruption. */
export function createMeetingRealtimeOutputQueue(params: {
  transport: MeetingRealtimeAudioTransport;
  bytesPerMs: number;
  onFailure: (source: string, error: unknown) => void;
}) {
  let stopped = false;
  let generation = 0;
  let writePhase: "idle" | "scheduled" | "writing" = "idle";
  let activeWrite: symbol | undefined;
  let clearPending = 0;
  let clearAfterActive = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let pendingAudibleFrames = 0;
  let playableUntilMs = 0;
  let audibleUntilMs = 0;
  let preparedUntilMs = 0;
  let clearCount = 0;
  let lastClearAt: string | undefined;
  let clearTail = Promise.resolve();
  let prepared: PreparedOutput | undefined;
  const queue: Array<{
    audio: Buffer;
    audible: boolean;
    beginsOutput: boolean;
    generation: number;
    prepared?: PreparedOutput;
  }> = [];
  const maxPendingBytes = params.bytesPerMs * OUTPUT_MAX_PENDING_MS;
  const maxWriteBytes = params.bytesPerMs * OUTPUT_MAX_WRITE_MS;

  const reset = (error: unknown = new Error("Prepared meeting speech was canceled")) => {
    prepared?.completion?.reject(error);
    prepared = undefined;
    // Canceled freshness reads cannot hold the pump; native writes still must settle.
    if (writePhase === "scheduled") {
      writePhase = "idle";
      activeWrite = undefined;
    }
    generation += 1;
    queue.length = 0;
    pendingBytes = 0;
    pendingFrames = 0;
    pendingAudibleFrames = 0;
    playableUntilMs = 0;
    audibleUntilMs = 0;
    preparedUntilMs = 0;
  };
  const clearTransport = (): void => {
    if (stopped) {
      return;
    }
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    clearPending += 1;
    clearTail = clearTail
      .then(async () => {
        if (!stopped) {
          await params.transport.clearOutput();
        }
      })
      .catch((error: unknown) => params.onFailure("audio output clear", error))
      .finally(() => {
        clearPending -= 1;
        pump();
      });
  };
  const pump = () => {
    if (stopped || writePhase !== "idle" || clearPending > 0) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      return;
    }
    const batch = [next];
    let batchBytes = next.audio.byteLength;
    let batchFrames = 1;
    let batchAudibleFrames = Number(next.audible);
    while (batchBytes < maxWriteBytes) {
      const queued = queue[0];
      if (
        !queued ||
        queued.beginsOutput ||
        queued.prepared !== next.prepared ||
        queued.audio.byteLength > maxWriteBytes - batchBytes
      ) {
        break;
      }
      queue.shift();
      batch.push(queued);
      batchBytes += queued.audio.byteLength;
      batchFrames += 1;
      batchAudibleFrames += Number(queued.audible);
    }
    const audio =
      batch.length === 1
        ? next.audio
        : Buffer.concat(
            batch.map((entry) => entry.audio),
            batchBytes,
          );
    writePhase = "scheduled";
    const writeToken = Symbol("meeting-output-write");
    activeWrite = writeToken;
    let transportPending = false;
    void Promise.resolve()
      .then(async () => {
        if (stopped || next.generation !== generation) {
          return;
        }
        const preparation = next.prepared;
        if (preparation) {
          preparation.assertCurrent?.();
          if (!preparation.refreshed) {
            preparation.refreshed = true;
            await preparation.refreshCurrent?.();
            if (stopped || next.generation !== generation) {
              return;
            }
            preparation.assertCurrent?.();
          }
        }
        if (stopped || next.generation !== generation) {
          return;
        }
        if (next.beginsOutput) {
          preparation?.onStarted?.();
          preparation?.assertCurrent?.();
          if (stopped || next.generation !== generation) {
            return;
          }
          transportPending = true;
          params.transport.beginOutput?.();
          transportPending = false;
        }
        preparation?.assertCurrent?.();
        if (stopped || next.generation !== generation) {
          return;
        }
        transportPending = true;
        writePhase = "writing";
        await params.transport.writeOutput(audio);
        transportPending = false;
        if (!stopped && next.generation === generation) {
          preparation?.assertCurrent?.();
          // Native write completion admits audio to playback; it does not mean it was heard.
          playableUntilMs = Math.max(Date.now(), playableUntilMs);
          for (const entry of batch) {
            playableUntilMs += entry.audio.byteLength / params.bytesPerMs;
            if (entry.audible) {
              audibleUntilMs = playableUntilMs;
              if (entry.prepared) {
                preparedUntilMs = playableUntilMs;
              }
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (!stopped && next.generation === generation) {
          if (next.prepared) {
            reset(error);
            clearTransport();
          }
          if (!next.prepared || transportPending) {
            params.onFailure("audio output", error);
          }
        }
      })
      .finally(() => {
        if (activeWrite !== writeToken) {
          return;
        }
        activeWrite = undefined;
        writePhase = "idle";
        if (next.generation === generation) {
          pendingBytes -= batchBytes;
          pendingFrames -= batchFrames;
          pendingAudibleFrames -= batchAudibleFrames;
          if (next.prepared && pendingFrames === 0) {
            prepared = undefined;
            next.prepared.completion?.resolve();
          }
        }
        if (clearAfterActive && !stopped) {
          clearAfterActive = false;
          clearTransport();
          return;
        }
        pump();
      });
  };

  return {
    enqueue(audio: Buffer, audible: boolean, beginsOutput: boolean): boolean {
      if (
        stopped ||
        prepared ||
        audio.byteLength > maxPendingBytes - pendingBytes ||
        pendingFrames >= OUTPUT_MAX_PENDING_FRAMES
      ) {
        return false;
      }
      pendingBytes += audio.byteLength;
      pendingFrames += 1;
      pendingAudibleFrames += Number(audible);
      queue.push({ audio, audible, beginsOutput, generation });
      pump();
      return true;
    },
    reservePrepared(): symbol | undefined {
      if (stopped || prepared || pendingFrames > 0) {
        return undefined;
      }
      const token = Symbol("meeting-prepared-output");
      prepared = { token, generation, refreshed: false };
      return token;
    },
    enqueuePrepared(
      token: symbol,
      audio: Buffer,
      guards: {
        assertCurrent?: () => void;
        refreshCurrent?: () => Promise<void>;
        onStarted?: () => void;
      } = {},
    ): Promise<void> {
      const preparation = prepared;
      if (
        stopped ||
        !preparation ||
        preparation.token !== token ||
        preparation.generation !== generation ||
        preparation.completion
      ) {
        return Promise.reject(new Error("Prepared meeting speech is no longer current"));
      }
      if (audio.byteLength === 0 || audio.byteLength > params.bytesPerMs * OUTPUT_MAX_PREPARED_MS) {
        return Promise.reject(
          new Error("Prepared meeting speech must contain at most 120 seconds of audio"),
        );
      }
      preparation.completion = createDeferredCore();
      preparation.assertCurrent = guards.assertCurrent;
      preparation.refreshCurrent = guards.refreshCurrent;
      preparation.onStarted = guards.onStarted;
      // Only this bounded, already-synthesized buffer bypasses streaming backpressure.
      for (let offset = 0; offset < audio.byteLength; offset += maxWriteBytes) {
        const chunk = audio.subarray(offset, offset + maxWriteBytes);
        queue.push({
          audio: chunk,
          audible: true,
          beginsOutput: offset === 0,
          generation,
          prepared: preparation,
        });
        pendingBytes += chunk.byteLength;
        pendingFrames += 1;
        pendingAudibleFrames += 1;
      }
      pump();
      // Completion means native admission, not that the utterance has been heard.
      return preparation.completion.promise;
    },
    releasePrepared(token: symbol): void {
      if (prepared?.token !== token) {
        return;
      }
      const admitted = prepared.completion !== undefined;
      clearAfterActive ||= writePhase === "writing";
      reset();
      if (admitted) {
        clearTransport();
      }
    },
    invalidate(): void {
      // A node command can complete after a clear; clear once more before new writes.
      clearAfterActive ||= writePhase === "writing";
      reset();
    },
    clear(): void {
      if (prepared) {
        clearAfterActive ||= writePhase === "writing";
        reset();
      }
      preparedUntilMs = 0;
      clearTransport();
    },
    stop(): void {
      stopped = true;
      clearAfterActive = false;
      reset();
    },
    pending: () => ({ pendingBytes, pendingFrames }),
    hasUnplayedAudibleAudio: () => pendingAudibleFrames > 0 || Date.now() < audibleUntilMs,
    hasUnplayedPreparedAudio: () => Boolean(prepared?.completion) || Date.now() < preparedUntilMs,
    getHealth: () => ({ clearCount, lastClearAt }),
  };
}

export function createMeetingRealtimeOutputOwner() {
  let nextResponseId: string | undefined;
  let announcedResponseId: string | undefined;
  let currentResponseId: string | undefined;
  let blocked: { responseId?: string; token: symbol; acceptNextResponse?: boolean } | undefined;
  let exactSpeech: symbol | undefined;
  let suppressContinuousTail = false;
  const staleResponseIds = new Set<string>();

  const rememberStale = (responseId: string) => {
    staleResponseIds.delete(responseId);
    staleResponseIds.add(responseId);
    while (staleResponseIds.size > STALE_RESPONSE_LIMIT) {
      const oldest = staleResponseIds.values().next().value;
      if (!oldest) {
        break;
      }
      staleResponseIds.delete(oldest);
    }
  };

  return {
    acceptContinuous(audible: boolean): boolean {
      if (exactSpeech) {
        // Silence during a reservation is not a boundary for the suppressed response.
        suppressContinuousTail ||= audible;
        return false;
      }
      if (suppressContinuousTail) {
        if (audible) {
          return false;
        }
        suppressContinuousTail = false;
      }
      return true;
    },
    accept(responseId: string | undefined): boolean {
      if (exactSpeech) {
        if (responseId) {
          rememberStale(responseId);
        }
        return false;
      }
      if (responseId && staleResponseIds.has(responseId)) {
        return false;
      }
      if (blocked) {
        if (
          !responseId ||
          responseId === blocked.responseId ||
          (!blocked.responseId && !blocked.acceptNextResponse)
        ) {
          return false;
        }
        blocked = undefined;
      }
      if (responseId) {
        currentResponseId = responseId;
      }
      return true;
    },
    block(exactPlayback = false): { blocked: boolean; token: symbol } {
      const interruptedIdleSpeech =
        (exactSpeech !== undefined || exactPlayback) && !currentResponseId && !announcedResponseId;
      exactSpeech = undefined;
      if (blocked) {
        if (interruptedIdleSpeech && !blocked.responseId) {
          blocked.acceptNextResponse = true;
        }
        return { blocked: false, token: blocked.token };
      }
      const token = Symbol("meeting-realtime-output-blocked");
      const responseId = currentResponseId ?? announcedResponseId;
      blocked = {
        ...(responseId ? { responseId } : {}),
        token,
        acceptNextResponse: interruptedIdleSpeech,
      };
      if (responseId) {
        rememberStale(responseId);
      }
      nextResponseId = undefined;
      return { blocked: true, token };
    },
    clearBlocked(): boolean {
      if (!blocked) {
        return false;
      }
      blocked = undefined;
      return true;
    },
    isBlockedBy(token: symbol): boolean {
      return blocked?.token === token;
    },
    reserveExactSpeech(): symbol {
      exactSpeech = Symbol("meeting-exact-speech");
      return exactSpeech;
    },
    isExactSpeechCurrent(token: symbol): boolean {
      return exactSpeech === token;
    },
    hasExactSpeech(): boolean {
      return exactSpeech !== undefined;
    },
    releaseExactSpeech(token: symbol): void {
      if (exactSpeech === token) {
        exactSpeech = undefined;
        // End the takeover block; interrupted reservations cannot release a newer block.
        blocked = undefined;
      }
    },
    noteEvent(event: RealtimeVoiceBridgeEvent): void {
      if (exactSpeech && event.direction === "server" && event.responseId) {
        rememberStale(event.responseId);
      }
      if (event.direction === "server" && event.type === "response.created" && event.responseId) {
        announcedResponseId = event.responseId;
        nextResponseId = undefined;
        return;
      }
      nextResponseId =
        event.direction === "server" && AUDIO_DELTA_EVENTS.has(event.type)
          ? (event.responseId ?? announcedResponseId)
          : undefined;
    },
    providerClear(): boolean {
      if (blocked) {
        if (!blocked.responseId) {
          blocked = undefined;
        }
        return false;
      }
      exactSpeech = undefined;
      const responseId = currentResponseId ?? announcedResponseId;
      if (responseId) {
        blocked = { responseId, token: Symbol("meeting-realtime-output-blocked") };
        rememberStale(responseId);
      }
      nextResponseId = undefined;
      return true;
    },
    reset(): void {
      exactSpeech = undefined;
      suppressContinuousTail = false;
      nextResponseId = undefined;
      announcedResponseId = undefined;
      currentResponseId = undefined;
      blocked = undefined;
      staleResponseIds.clear();
    },
    takeNextResponseId(): string | undefined {
      const responseId = nextResponseId ?? announcedResponseId;
      nextResponseId = undefined;
      return responseId;
    },
    terminal(responseId: string | undefined): boolean {
      if (!responseId || !blocked?.responseId || blocked.responseId === responseId) {
        blocked = undefined;
      }
      if (!responseId || announcedResponseId === responseId) {
        announcedResponseId = undefined;
      }
      if (responseId && currentResponseId && currentResponseId !== responseId) {
        return false;
      }
      currentResponseId = undefined;
      return true;
    },
  };
}

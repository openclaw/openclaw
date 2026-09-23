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

/** Serializes native playback writes and fences queued audio across interruption. */
export function createMeetingRealtimeOutputQueue(params: {
  transport: MeetingRealtimeAudioTransport;
  bytesPerMs: number;
  onFailure: (source: string, error: unknown) => void;
}) {
  let stopped = false;
  let generation = 0;
  let writePhase: "idle" | "scheduled" | "writing" = "idle";
  let clearPending = 0;
  let clearAfterActive = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let pendingAudibleFrames = 0;
  let playableUntilMs = 0;
  let audibleUntilMs = 0;
  let clearCount = 0;
  let lastClearAt: string | undefined;
  let clearTail = Promise.resolve();
  const queue: Array<{
    audio: Buffer;
    audible: boolean;
    beginsOutput: boolean;
    generation: number;
  }> = [];
  const maxPendingBytes = params.bytesPerMs * OUTPUT_MAX_PENDING_MS;
  const maxWriteBytes = params.bytesPerMs * OUTPUT_MAX_WRITE_MS;

  const reset = () => {
    generation += 1;
    queue.length = 0;
    pendingBytes = 0;
    pendingFrames = 0;
    pendingAudibleFrames = 0;
    playableUntilMs = 0;
    audibleUntilMs = 0;
  };
  const clear = (): void => {
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
      if (!queued || queued.beginsOutput || queued.audio.byteLength > maxWriteBytes - batchBytes) {
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
    void Promise.resolve()
      .then(async () => {
        if (stopped || next.generation !== generation) {
          return;
        }
        if (next.beginsOutput) {
          params.transport.beginOutput?.();
        }
        writePhase = "writing";
        await params.transport.writeOutput(audio);
        if (!stopped && next.generation === generation) {
          // Native write completion admits audio to playback; it does not mean it was heard.
          playableUntilMs = Math.max(Date.now(), playableUntilMs);
          for (const entry of batch) {
            playableUntilMs += entry.audio.byteLength / params.bytesPerMs;
            if (entry.audible) {
              audibleUntilMs = playableUntilMs;
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (!stopped && next.generation === generation) {
          params.onFailure("audio output", error);
        }
      })
      .finally(() => {
        writePhase = "idle";
        if (next.generation === generation) {
          pendingBytes -= batchBytes;
          pendingFrames -= batchFrames;
          pendingAudibleFrames -= batchAudibleFrames;
        }
        if (clearAfterActive && !stopped) {
          clearAfterActive = false;
          clear();
          return;
        }
        pump();
      });
  };

  return {
    enqueue(audio: Buffer, audible: boolean, beginsOutput: boolean): boolean {
      if (
        stopped ||
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
    invalidate(): void {
      // A node command can complete after a clear; clear once more before new writes.
      clearAfterActive ||= writePhase === "writing";
      reset();
    },
    clear,
    stop(): void {
      stopped = true;
      clearAfterActive = false;
      reset();
    },
    pending: () => ({ pendingBytes, pendingFrames }),
    hasUnplayedAudibleAudio: () => pendingAudibleFrames > 0 || Date.now() < audibleUntilMs,
    getHealth: () => ({ clearCount, lastClearAt }),
  };
}

export function createMeetingRealtimeOutputOwner() {
  let nextResponseId: string | undefined;
  let announcedResponseId: string | undefined;
  let currentResponseId: string | undefined;
  let blocked: { responseId?: string; token: symbol } | undefined;
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
    accept(responseId: string | undefined): boolean {
      if (responseId && staleResponseIds.has(responseId)) {
        return false;
      }
      if (blocked) {
        if (!blocked.responseId || !responseId || responseId === blocked.responseId) {
          return false;
        }
        blocked = undefined;
      }
      if (responseId) {
        currentResponseId = responseId;
      }
      return true;
    },
    block(): { blocked: boolean; token: symbol } {
      if (blocked) {
        return { blocked: false, token: blocked.token };
      }
      const token = Symbol("meeting-realtime-output-blocked");
      const responseId = currentResponseId ?? announcedResponseId;
      blocked = { ...(responseId ? { responseId } : {}), token };
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
    noteEvent(event: RealtimeVoiceBridgeEvent): void {
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
      const responseId = currentResponseId ?? announcedResponseId;
      if (responseId) {
        blocked = { responseId, token: Symbol("meeting-realtime-output-blocked") };
        rememberStale(responseId);
      }
      nextResponseId = undefined;
      return true;
    },
    reset(): void {
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

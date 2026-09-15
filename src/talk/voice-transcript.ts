import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";

const VOICE_TRANSCRIPT_MAX_CHARS = 8_000;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING = 40;
export const VOICE_TRANSCRIPT_MAX_UNRESOLVED = VOICE_TRANSCRIPT_QUEUE_MAX_PENDING + 1;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS =
  VOICE_TRANSCRIPT_QUEUE_MAX_PENDING * VOICE_TRANSCRIPT_MAX_CHARS;
const VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE =
  "Voice transcript persistence could not keep up; the realtime session was stopped.";

export function normalizeVoiceTranscriptText(text: string): string {
  return truncateUtf16Safe(text.trim(), VOICE_TRANSCRIPT_MAX_CHARS);
}

export function buildPersistedVoiceMessage(params: {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  provider: string;
}): Record<string, unknown> {
  const provenance = { kind: "realtime_voice", sourceChannel: "talk" };
  if (params.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: params.text }],
      timestamp: params.timestamp,
      provenance,
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "realtime",
    provider: params.provider,
    model: "realtime-voice",
    stopReason: "stop",
    timestamp: params.timestamp,
    provenance,
  };
}

export const VOICE_TRANSCRIPT_QUEUE_POLICY = {
  maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
  maxEntryChars: VOICE_TRANSCRIPT_MAX_CHARS,
  overflowMessage: VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE,
  createQueue: () =>
    new BoundedSerialQueue({
      maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
      maxPendingWeight: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS,
    }),
} as const;

type VoiceTranscriptClose = {
  promise: Promise<boolean>;
  conditional: boolean;
  laterAdmission: boolean;
};

type VoiceTranscriptOperationOwner = {
  queue: BoundedSerialQueue;
  close?: VoiceTranscriptClose;
};

class VoiceTranscriptOperationRegistry {
  private readonly owners = new Map<string, VoiceTranscriptOperationOwner>();

  constructor(
    private readonly queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
  ) {}

  private getOrCreate(key: string): VoiceTranscriptOperationOwner {
    const existing = this.owners.get(key);
    if (existing) {
      return existing;
    }
    const created = { queue: this.queuePolicy.createQueue() };
    this.owners.set(key, created);
    return created;
  }

  private cleanup(key: string, owner: VoiceTranscriptOperationOwner): void {
    if (
      this.owners.get(key) === owner &&
      !owner.close &&
      owner.queue.isIdle &&
      !owner.queue.didOverflow
    ) {
      this.owners.delete(key);
    }
  }

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    options: { weight?: number; waitForCapacity?: boolean } = {},
  ): Promise<T> {
    while (true) {
      const owner = this.getOrCreate(key);
      if (owner.close && !owner.close.conditional) {
        if (options.waitForCapacity !== true) {
          throw new Error("voice transcript persistence session is closing");
        }
        try {
          await owner.close.promise;
        } catch {
          // Control work retries on a fresh owner after a failed close releases this one.
        }
        continue;
      }
      // Control work may wait for the accepted transcript prefix, but must not
      // be the event that seals transcript admission. Real overflow stays terminal.
      const admission = owner.queue.enqueue(operation, {
        weight: options.weight,
        sealOnOverflow: options.waitForCapacity !== true,
      });
      if (admission.accepted) {
        if (owner.close?.conditional) {
          owner.close.laterAdmission = true;
        }
        void admission.completion.then(
          () => this.cleanup(key, owner),
          () => this.cleanup(key, owner),
        );
        return await admission.completion;
      }
      if (owner.queue.didOverflow || options.waitForCapacity !== true) {
        throw new Error(
          owner.queue.didOverflow
            ? "voice transcript persistence queue capacity exceeded"
            : "voice transcript persistence session is closed",
        );
      }
      if (admission.reason !== "capacity") {
        throw new Error("voice transcript persistence session is closed");
      }
      await owner.queue.flush();
      this.cleanup(key, owner);
    }
  }

  async close(
    key: string,
    operation: (trySeal: () => boolean) => Promise<boolean>,
    conditional = false,
  ): Promise<boolean> {
    const owner = this.getOrCreate(key);
    if (!owner.close) {
      if (!conditional) {
        owner.queue.seal();
      }
      const close: VoiceTranscriptClose = {
        conditional,
        laterAdmission: false,
        promise: owner.queue.flush({ requireSuccess: true }).then(() =>
          operation(() => {
            // The admitted transaction rechecks freshness before requesting this fence.
            // A later accepted task can already have failed without updating the record.
            if (close.laterAdmission || !owner.queue.isIdle) {
              return false;
            }
            owner.queue.seal();
            close.conditional = false;
            return true;
          }),
        ),
      };
      owner.close = close;
    } else if (owner.close.conditional && !conditional) {
      const recovery = owner.close.promise;
      // Hangup seals immediately, including work admitted after recovery's first flush.
      owner.queue.seal();
      const prefix = owner.queue.flush({ requireSuccess: true });
      owner.close = {
        conditional: false,
        laterAdmission: false,
        promise: Promise.allSettled([recovery, prefix]).then(([closed, drained]) => {
          if (closed.status === "rejected") {
            throw closed.reason;
          }
          if (drained.status === "rejected") {
            throw drained.reason;
          }
          return closed.value ? true : operation(() => true);
        }),
      };
    }
    const close = owner.close;
    try {
      return await close.promise;
    } finally {
      if (this.owners.get(key) === owner && owner.close === close) {
        if (close.conditional) {
          owner.close = undefined;
          this.cleanup(key, owner);
        } else {
          this.owners.delete(key);
        }
      }
    }
  }

  async flush(key: string): Promise<void> {
    await this.owners.get(key)?.queue.flush({ requireSuccess: true });
  }

  clear(): void {
    this.owners.clear();
  }
}

export function createVoiceTranscriptOperationRegistry(
  queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
): VoiceTranscriptOperationRegistry {
  return new VoiceTranscriptOperationRegistry(queuePolicy);
}

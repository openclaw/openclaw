import type { NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.types.js";
export interface SendFinalPayloadOptions {
  abortSignal?: AbortSignal | false;
  deliveryId?: string;
  deferredTtsText?: string;
  skipTts?: boolean;
}

export interface SendFinalPayloadOutcome {
  blockDeliveryOutcome?: ReplyDispatchDeliveryOutcome;
  pendingBlock?: boolean;
  queuedFinal: boolean;
  routedFinalCount: number;
  suppressionReason?: NormalizeReplySkipReason;
  /**
   * Text this delivery actually prepared for speech: dispatcher normalization has
   * already run on it (silent/heartbeat tokens stripped, deferred block text merged),
   * and TTS has not. A caller that synthesizes its own follow-up audio must speak
   * this, not the raw reply — the recording cannot be normalized after the fact.
   */
  preparedSpeechText?: string;
  sessionWriterDeliveryRevoked?: true;
  dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
  routedOutcome?: ReplyDispatchDeliveryOutcome;
}

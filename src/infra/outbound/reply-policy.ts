// Reply policy coordinates explicit and implicit reply-to ids across chunked or
// multi-payload outbound delivery.
import { isSingleUseReplyToMode } from "../../auto-reply/reply/reply-reference.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/types.js";

/** Per-payload reply target override passed to outbound channel adapters. */
export type ReplyToOverride = {
  replyToId?: string | null | undefined;
  replyToIdSource?: ReplyToResolution["source"] | undefined;
};

/** Resolved reply target plus whether it came from payload or ambient context. */
export type ReplyToResolution = {
  replyToId?: string;
  source?: "explicit" | "implicit";
};

/** Creates a reply-to supplier that consumes implicit single-use reply ids once. */
export function createReplyToFanout(params: {
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  replyToIdSource?: ReplyToResolution["source"];
}): () => string | undefined {
  const replyToId = params.replyToId ?? undefined;
  if (!replyToId) {
    return () => undefined;
  }
  const singleUse =
    params.replyToIdSource !== "explicit" &&
    params.replyToMode !== undefined &&
    isSingleUseReplyToMode(params.replyToMode);
  if (!singleUse) {
    return () => replyToId;
  }
  let current: string | undefined = replyToId;
  return () => {
    const value = current;
    current = undefined;
    return value;
  };
}

/** Builds per-payload reply routing policy for outbound delivery batches. */
export function createReplyToDeliveryPolicy(params: {
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  /** Channels that treat replyToId as a one-shot quote bubble (e.g. signal)
   *  consume the inherited reply on the first send even when replyToMode is
   *  not explicitly single-use. Defaults to false. */
  treatAsSingleUse?: boolean;
}): {
  resolveCurrentReplyTo: (payload: ReplyPayload) => ReplyToResolution;
  applyReplyToConsumption: <T extends ReplyToOverride>(
    overrides: T,
    options?: { consumeImplicitReply?: boolean },
  ) => T;
} {
  const modeIsSingleUse = params.replyToMode ? isSingleUseReplyToMode(params.replyToMode) : false;
  // Treat-as-single-use applies when the channel uses replyToId as one-shot
  // quote metadata, but only when the caller has not explicitly opted into a
  // multi-use mode like "all".
  const singleUseReplyTo =
    modeIsSingleUse || (params.treatAsSingleUse === true && params.replyToMode !== "all");
  let replyToConsumed = false;

  const resolveCurrentReplyTo = (payload: ReplyPayload): ReplyToResolution => {
    // Explicit null on a payload suppresses the inherited reply for that payload only.
    if (payload.replyToId === null) {
      return {};
    }
    if (typeof payload.replyToId === "string" && payload.replyToId.length > 0) {
      return { replyToId: payload.replyToId, source: "explicit" };
    }
    const replyToId = (params.replyToMode === "off" ? undefined : params.replyToId) ?? undefined;
    if (!replyToId) {
      return {};
    }
    if (!singleUseReplyTo) {
      return { replyToId, source: "implicit" };
    }
    return replyToConsumed ? {} : { replyToId, source: "implicit" };
  };

  const applyReplyToConsumption = <T extends ReplyToOverride>(
    overrides: T,
    options?: { consumeImplicitReply?: boolean },
  ): T => {
    if (!options?.consumeImplicitReply || !overrides.replyToId || !singleUseReplyTo) {
      return overrides;
    }
    if (replyToConsumed) {
      // Single-use implicit reply targets apply to the first delivered payload only;
      // later payloads must not accidentally thread into the same source message.
      return { ...overrides, replyToId: undefined };
    }
    replyToConsumed = true;
    return overrides;
  };

  return { resolveCurrentReplyTo, applyReplyToConsumption };
}

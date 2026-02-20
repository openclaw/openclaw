import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import type { OriginatingChannelType } from "../templating.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { scheduleFollowupDrain } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

/**
 * Synthetic/internal provider names that must never be treated as real deliverable
 * reply channels.  These are injected by heartbeat-runner, cron service, and similar
 * internal triggers that carry fake From/To/Provider values.  Using them as a
 * replyToChannel would corrupt the session's outbound routing.
 */
export const INTERNAL_PROVIDER_NAMES = new Set([
  "heartbeat",
  "cron-event",
  "exec-event",
  "isolated",
  "system",
]);

/**
 * Returns undefined when the channel is an internal synthetic provider, otherwise
 * returns the channel as-is.  Use this wherever a provider string is being promoted
 * to a reply-routing channel.
 */
export function filterInternalChannel(
  channel: string | undefined,
): OriginatingChannelType | undefined {
  if (!channel) {
    return undefined;
  }
  if (INTERNAL_PROVIDER_NAMES.has(channel)) {
    return undefined;
  }
  return channel as OriginatingChannelType;
}

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined));

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

function resolveCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const store = loadSessionStore(params.storePath);
    const entry = store[params.sessionKey];
    return normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = normalizeVerboseLevel(String(params.resolvedVerboseLevel ?? "")) ?? "off";
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel(params) ?? fallbackVerbose);
  };
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

export const finalizeWithFollowup = <T>(
  value: T,
  queueKey: string,
  runFollowupTurn: Parameters<typeof scheduleFollowupDrain>[1],
): T => {
  scheduleFollowupDrain(queueKey, runFollowupTurn);
  return value;
};

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) => {
    const trimmed = payload.text?.trim();
    if (trimmed) {
      return true;
    }
    if (payload.mediaUrl) {
      return true;
    }
    if (payload.mediaUrls && payload.mediaUrls.length > 0) {
      return true;
    }
    return false;
  });
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};

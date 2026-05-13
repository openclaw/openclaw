import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { getSessionEntry } from "../../config/sessions/store.js";
import { isAudioFileName } from "../../media/mime.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  resolvedVerboseLevel: VerboseLevel;
};

const VERBOSE_GATE_SESSION_REFRESH_MS = 250;

function readCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey) {
    return undefined;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    if (!agentId) {
      return undefined;
    }
    const entry = getSessionEntry({ agentId, sessionKey: params.sessionKey });
    return typeof entry?.verboseLevel === "string"
      ? normalizeVerboseLevel(entry.verboseLevel)
      : undefined;
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createCurrentVerboseLevelResolver(
  params: VerboseGateParams,
): () => VerboseLevel | undefined {
  let cachedLevel: VerboseLevel | undefined;
  let cachedAtMs = Number.NEGATIVE_INFINITY;
  return () => {
    if (!params.sessionKey) {
      return undefined;
    }
    const now = Date.now();
    if (now - cachedAtMs < VERBOSE_GATE_SESSION_REFRESH_MS) {
      return cachedLevel;
    }
    cachedLevel = readCurrentVerboseLevel(params);
    cachedAtMs = now;
    return cachedLevel;
  };
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from SQLite session rows/config so false/"false" still means off.
  const fallbackVerbose = params.resolvedVerboseLevel;
  const resolveCurrentVerboseLevel = createCurrentVerboseLevelResolver(params);
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel() ?? fallbackVerbose);
  };
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};

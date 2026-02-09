import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import { resolveThreadParentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import { scheduleFollowupDrain } from "./queue.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined));

export const createShouldEmitToolResult = (params: {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): (() => boolean) => {
  const isGroupSession = /:(group|channel):/.test(params.sessionKey ?? "");
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = normalizeVerboseLevel(String(params.resolvedVerboseLevel ?? "")) ?? "off";
  return () => {
    const readCurrentVerbose = (): VerboseLevel | undefined => {
      if (!params.sessionKey || !params.storePath) {
        return undefined;
      }
      try {
        const store = loadSessionStore(params.storePath);
        const sessionKey = params.sessionKey;
        const entry = store[sessionKey];
        const current = normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
        if (current) {
          return current;
        }
        // For topic/thread sessions, inherit verbose setting from parent group session when present.
        const parentKey = resolveThreadParentSessionKey(sessionKey);
        if (parentKey) {
          const parent = store[parentKey];
          const parentVerbose = normalizeVerboseLevel(String(parent?.verboseLevel ?? ""));
          if (parentVerbose) {
            return parentVerbose;
          }
        }
      } catch {
        // ignore store read failures
      }
      return undefined;
    };

    // Group chats default to tool summaries on, but explicit `/v off` must disable them.
    if (isGroupSession) {
      const current = readCurrentVerbose();
      if (current) {
        return current !== "off";
      }
      return true;
    }

    const current = readCurrentVerbose();
    if (current) {
      return current !== "off";
    }
    return fallbackVerbose !== "off";
  };
};

export const createShouldEmitToolOutput = (params: {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): (() => boolean) => {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = normalizeVerboseLevel(String(params.resolvedVerboseLevel ?? "")) ?? "off";
  return () => {
    if (!params.sessionKey || !params.storePath) {
      return fallbackVerbose === "full";
    }
    try {
      const store = loadSessionStore(params.storePath);
      const entry = store[params.sessionKey];
      const current = normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
      if (current) {
        return current === "full";
      }
    } catch {
      // ignore store read failures
    }
    return fallbackVerbose === "full";
  };
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

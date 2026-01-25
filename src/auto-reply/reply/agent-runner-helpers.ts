import { loadSessionStore } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isAudioFileName } from "../../media/mime.js";
import { emitRunCompletion } from "../continuation/emit.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { scheduleFollowupDrain } from "./queue.js";
import type { FollowupRun } from "./queue/types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined));

export const createShouldEmitToolResult = (params: {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): (() => boolean) => {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = normalizeVerboseLevel(String(params.resolvedVerboseLevel ?? "")) ?? "off";
  return () => {
    if (!params.sessionKey || !params.storePath) {
      return fallbackVerbose !== "off";
    }
    try {
      const store = loadSessionStore(params.storePath);
      const entry = store[params.sessionKey];
      const current = normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
      if (current) return current !== "off";
    } catch {
      // ignore store read failures
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
      if (current) return current === "full";
    } catch {
      // ignore store read failures
    }
    return fallbackVerbose === "full";
  };
};

export type RunCompletionContext = {
  runId: string;
  sessionId: string;
  sessionKey: string;
  payloads: ReplyPayload[];
  autoCompactionCompleted: boolean;
  model: string;
  provider: string;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
};

export const finalizeWithFollowup = async <T>(
  value: T,
  queueKey: string,
  runFollowupTurn: Parameters<typeof scheduleFollowupDrain>[1],
  continuationContext?: RunCompletionContext,
): Promise<T> => {
  // Check for continuation before scheduling drain
  if (continuationContext) {
    const decision = await emitRunCompletion({
      ...continuationContext,
      queueKey,
    });

    if (decision.action !== "none" && decision.nextPrompt) {
      enqueueFollowupRun(
        queueKey,
        {
          prompt: decision.nextPrompt,
          run: continuationContext.followupRun.run,
          enqueuedAt: Date.now(),
        },
        { mode: "followup" },
      );
    }
  }

  scheduleFollowupDrain(queueKey, runFollowupTurn);
  return value;
};

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) => {
    const trimmed = payload.text?.trim();
    if (trimmed) return true;
    if (payload.mediaUrl) return true;
    if (payload.mediaUrls && payload.mediaUrls.length > 0) return true;
    return false;
  });
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};

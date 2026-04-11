import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { hasToolCall } from "../utils/transcript-tools.js";
import { sessionsHandlers } from "./server-methods/sessions.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  loadCombinedSessionStoreForGateway,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

export const DEFAULT_STARTUP_STUCK_SESSION_REPLAY_MESSAGE =
  "Gateway restarted and your previous turn may be unanswered. Continue from the latest pending user request and send the reply now. Avoid duplicating already-sent messages.";
export const DEFAULT_STARTUP_STUCK_SESSION_REPLAY_CAP = 10;
export const DEFAULT_STARTUP_REPLAY_SEND_TIMEOUT_MS = 30_000;

const INTERNAL_CHANNELS = new Set(["internal", "cron"]);

export type StartupStuckSessionReason = "pending-user-turn" | "assistant-empty-no-tools";

type StartupReplayCandidate = {
  key: string;
  sessionId: string;
  updatedAt: number;
  reason: StartupStuckSessionReason;
  storePath: string;
  sessionFile?: string;
};

type StartupReplayLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type TranscriptMessage = {
  role?: string;
  content?: unknown;
  text?: unknown;
  attachments?: unknown;
};

function hasMeaningfulUserMessage(message: TranscriptMessage): boolean {
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return true;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    for (const entry of message.content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const block = entry as { type?: unknown; text?: unknown };
      if (typeof block.text === "string" && block.text.trim().length > 0) {
        return true;
      }
      if (
        typeof block.type === "string" &&
        normalizeLowercaseStringOrEmpty(block.type) !== "text"
      ) {
        return true;
      }
    }
  }
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return true;
  }
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

export function detectStartupStuckSessionReason(
  messages: unknown[],
): StartupStuckSessionReason | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const message = raw as TranscriptMessage;
    const role = normalizeLowercaseStringOrEmpty(message.role);
    if (role === "user") {
      if (hasMeaningfulUserMessage(message)) {
        return "pending-user-turn";
      }
      continue;
    }
    if (role !== "assistant") {
      continue;
    }
    const assistantText =
      extractAssistantVisibleText(message as Record<string, unknown>)?.trim() ?? "";
    if (assistantText.length > 0) {
      return null;
    }
    if (hasToolCall(message as Record<string, unknown>)) {
      return null;
    }
    return "assistant-empty-no-tools";
  }
  return null;
}

function resolveReplayChannel(params: { key: string; entry: SessionEntry }): string {
  const direct =
    (typeof params.entry.channel === "string" ? params.entry.channel : "") ||
    (typeof params.entry.deliveryContext?.channel === "string"
      ? params.entry.deliveryContext.channel
      : "") ||
    (typeof params.entry.lastChannel === "string" ? params.entry.lastChannel : "");
  if (direct) {
    return normalizeLowercaseStringOrEmpty(direct);
  }
  const parsed = parseAgentSessionKey(params.key);
  if (!parsed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(parsed.rest.split(":")[0]);
}

export function shouldSkipStartupReplaySession(params: {
  key: string;
  entry: SessionEntry;
}): boolean {
  const loweredKey = normalizeLowercaseStringOrEmpty(params.key);
  if (loweredKey === "global" || loweredKey === "unknown") {
    return true;
  }
  if (isCronRunSessionKey(params.key)) {
    return true;
  }
  const channel = resolveReplayChannel(params);
  if (!channel) {
    return true;
  }
  return INTERNAL_CHANNELS.has(channel) || isInternalMessageChannel(channel);
}

export function selectStartupReplayCandidates(
  candidates: StartupReplayCandidate[],
  maxRecoveries: number,
): StartupReplayCandidate[] {
  const cap = Math.max(1, Math.min(maxRecoveries, DEFAULT_STARTUP_STUCK_SESSION_REPLAY_CAP));
  return [...candidates].toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, cap);
}

async function sendStartupReplayMessage(params: {
  key: string;
  message: string;
  idempotencyKey: string;
  context: GatewayRequestContext;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_STARTUP_REPLAY_SEND_TIMEOUT_MS;
  const sendPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const handlerResult = sessionsHandlers["sessions.send"]({
      req: {
        type: "req",
        id: `startup-stuck-replay-${randomUUID()}`,
        method: "sessions.send",
        params: {
          key: params.key,
          message: params.message,
          idempotencyKey: params.idempotencyKey,
        },
      },
      params: {
        key: params.key,
        message: params.message,
        idempotencyKey: params.idempotencyKey,
      },
      respond: (ok, _payload, error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (ok) {
          resolve();
          return;
        }
        reject(new Error(error?.message ?? `sessions.send failed for ${params.key}`));
      },
      context: params.context,
      client: null,
      isWebchatConnect: () => false,
    });
    Promise.resolve(handlerResult)
      .then(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`sessions.send produced no response for ${params.key}`));
        }
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () =>
        reject(new Error(`startup replay send timed out after ${timeoutMs}ms for ${params.key}`)),
      timeoutMs,
    );
  });
  await Promise.race([sendPromise, timeoutPromise]);
}

export async function runStartupStuckSessionReplay(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  log: StartupReplayLog;
  replayMessage?: string;
  maxRecoveries?: number;
  deps?: {
    readMessages?: typeof readSessionMessages;
    sendMessage?: typeof sendStartupReplayMessage;
    loadCombinedStore?: typeof loadCombinedSessionStoreForGateway;
    resolveStoreTarget?: typeof resolveGatewaySessionStoreTarget;
  };
}): Promise<void> {
  const replayMessage = params.replayMessage ?? DEFAULT_STARTUP_STUCK_SESSION_REPLAY_MESSAGE;
  const readMessages = params.deps?.readMessages ?? readSessionMessages;
  const sendMessage = params.deps?.sendMessage ?? sendStartupReplayMessage;
  const loadCombinedStore = params.deps?.loadCombinedStore ?? loadCombinedSessionStoreForGateway;
  const resolveStoreTarget = params.deps?.resolveStoreTarget ?? resolveGatewaySessionStoreTarget;

  const { store } = loadCombinedStore(params.cfg);
  const ordered = Object.entries(store)
    .filter(([, entry]) => Boolean(entry?.sessionId))
    .filter(([key, entry]) => !shouldSkipStartupReplaySession({ key, entry }))
    .toSorted((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));

  const detectedCandidates: StartupReplayCandidate[] = [];
  let scanned = 0;
  let failed = 0;
  for (const [key, entry] of ordered) {
    scanned += 1;
    try {
      const storeTarget = resolveStoreTarget({
        cfg: params.cfg,
        key,
        scanLegacyKeys: false,
        store,
      });
      const messages = readMessages(entry.sessionId, storeTarget.storePath, entry.sessionFile);
      const reason = detectStartupStuckSessionReason(messages);
      if (!reason) {
        continue;
      }
      detectedCandidates.push({
        key,
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt ?? 0,
        reason,
        storePath: storeTarget.storePath,
        sessionFile: entry.sessionFile,
      });
    } catch (error) {
      failed += 1;
      params.log.warn(
        `gateway: startup stuck-session replay scan failed for ${key}: ${String(error)}`,
      );
    }
  }

  const selectedCandidates = selectStartupReplayCandidates(
    detectedCandidates,
    params.maxRecoveries ?? DEFAULT_STARTUP_STUCK_SESSION_REPLAY_CAP,
  );
  const replayBatchId = Date.now().toString(36);
  let replayed = 0;
  let skippedStale = 0;
  for (const [index, candidate] of selectedCandidates.entries()) {
    try {
      // Re-verify transcript tail to prevent replay-vs-live race:
      // if a new message arrived between scan and send, skip this candidate.
      const freshMessages = readMessages(
        candidate.sessionId,
        candidate.storePath,
        candidate.sessionFile,
      );
      const freshReason = detectStartupStuckSessionReason(freshMessages);
      if (!freshReason) {
        skippedStale += 1;
        params.log.info(
          `gateway: startup stuck-session replay skipped stale candidate ${candidate.key} (no longer stuck)`,
        );
        continue;
      }
      await sendMessage({
        key: candidate.key,
        message: replayMessage,
        idempotencyKey: `startup-stuck-replay:${replayBatchId}:${index}:${candidate.key}`,
        context: params.context,
      });
      replayed += 1;
    } catch (error) {
      failed += 1;
      params.log.warn(
        `gateway: startup stuck-session replay failed for ${candidate.key}: ${String(error)}`,
      );
    }
  }

  params.log.info(
    `gateway: startup stuck-session replay summary scanned=${scanned} candidates=${selectedCandidates.length} replayed=${replayed} skipped_stale=${skippedStale} failed=${failed}`,
  );
}

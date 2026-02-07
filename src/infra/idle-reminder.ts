/**
 * Idle Reminder V2: triggers a "simulated heartbeat" if the agent goes idle.
 * Bypasses the regular heartbeat-runner entirely — calls getReplyFromConfig
 * + deliverOutboundPayloads directly to avoid guard clauses.
 *
 * Flow:
 * 1. agent run 完成后 (任何回复, 包括 NO_REPLY/HEARTBEAT_OK/空) → startIdleReminder
 *    - 维护最近 3 条回复的滚动缓冲区
 * 2. 3 分钟后:
 *    a. 读 session entry → 拿 lastChannel/lastTo/lastAccountId
 *    b. 读 transcript 末尾 → 如果有新的非 HEARTBEAT_OK 内容 → 重置 timer
 *    c. 如果没有新内容 → 调用 getReplyFromConfig + deliverOutboundPayloads (附带最近3条回复)
 *    d. count++ → 如果 count < MAX, 再设 3 分钟 timer
 * 3. 只有 idle reminder 自己收到 HEARTBEAT_OK → 才停止计时 + 清除状态
 * 4. 用户发消息 → agent 回复 → startIdleReminder 重置 count, 追加新回复到缓冲区
 */

import fs from "node:fs";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/io.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";

const log = createSubsystemLogger("idle-reminder");

const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_REMIND_COUNT = 1;

const MAX_STORED_REPLIES = 3;

/** Build the idle reminder prompt, embedding the agent's last N replies for context. */
function buildIdleReminderPrompt(lastReplyTexts: string[]): string {
  const nonEmpty = lastReplyTexts.filter((t) => t.trim());
  if (nonEmpty.length === 0) {
    return "Check if there's anything you should follow up on with the user. Say it, then DO it — words without action = nothing happened. If nothing to follow up, reply HEARTBEAT_OK.";
  }
  const count = nonEmpty.length;
  const replyLines = nonEmpty.map((t, i) => {
    const label = i === nonEmpty.length - 1 ? `reply${i + 1}(latest)` : `reply${i + 1}`;
    return `${label}\n${t.trim()}`;
  });
  const replyBlock = `Here is your previous last ${count} reply:\n"""\n${replyLines.join("\n")}\n\n"""\n\n`;
  return `${replyBlock}Check if there's anything you should follow up on with the user. Say it, then DO it — words without action = nothing happened. If nothing to follow up, reply HEARTBEAT_OK.`;
}

type IdleReminderState = {
  sessionKey: string;
  storePath: string;
  timer: NodeJS.Timeout | null;
  timeoutMs: number;
  /** How many reminders sent this cycle (resets on user message / new activity). */
  count: number;
  /** Byte offset of transcript file when timer started / last checked. */
  lastTranscriptSize: number;
  /** Rolling buffer of the agent's last N reply texts (newest last). */
  lastReplyTexts: string[];
};

// Track active idle reminders per session
const activeReminders = new Map<string, IdleReminderState>();

/**
 * Start or reset the idle reminder timer for a session.
 * Called after every non-heartbeat agent run completes (regardless of reply content).
 * Maintains a rolling buffer of the last 3 reply texts for follow-up context.
 */
export function startIdleReminder(params: {
  sessionKey: string;
  storePath?: string;
  /** @deprecated No longer used in v2 — kept for callsite compat. */
  updatedAt?: number;
  timeoutMs?: number;
  /** The agent's last reply text — included in the idle reminder prompt. */
  lastReplyText?: string;
}): void {
  const { sessionKey, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = params;
  const storePath = params.storePath ?? resolveStorePath(undefined, {});

  // Clear existing timer if any; carry over previous reply texts
  const existing = activeReminders.get(sessionKey);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  // Build rolling buffer: carry over previous replies, append new one, keep max N
  const previousTexts = existing?.lastReplyTexts ?? [];
  const newReplyText = (params.lastReplyText ?? "").trim();
  const updatedTexts = newReplyText
    ? [...previousTexts, newReplyText].slice(-MAX_STORED_REPLIES)
    : previousTexts;

  // Snapshot transcript size so we can detect new content later
  const lastTranscriptSize = resolveTranscriptSize(sessionKey, storePath);

  const state: IdleReminderState = {
    sessionKey,
    storePath,
    timer: null,
    timeoutMs,
    count: 0,
    lastTranscriptSize,
    lastReplyTexts: updatedTexts,
  };

  state.timer = setTimeout(() => {
    void checkAndMaybeRemind(sessionKey);
  }, timeoutMs);
  state.timer.unref?.();

  activeReminders.set(sessionKey, state);
  log.debug("started", { sessionKey, timeoutMs });
}

/**
 * Stop the idle reminder for a session.
 * Called when receiving HEARTBEAT_OK from the original heartbeat system.
 */
export function stopIdleReminder(sessionKey: string): void {
  const state = activeReminders.get(sessionKey);
  if (!state) {
    return;
  }

  if (state.timer) {
    clearTimeout(state.timer);
  }
  activeReminders.delete(sessionKey);
  log.debug("stopped", { sessionKey });
}

// ---------------------------------------------------------------------------
// Transcript inspection
// ---------------------------------------------------------------------------

/** Get the byte size of the transcript file for a session, or 0 if not found. */
function resolveTranscriptSize(sessionKey: string, storePath: string): number {
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    if (!entry?.sessionId) {
      return 0;
    }
    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry);
    return fs.statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

/**
 * Read new bytes appended to the transcript since `lastSize` and check
 * whether any line is non-HEARTBEAT_OK content (i.e. real activity).
 */
function hasNewNonHeartbeatContent(
  sessionKey: string,
  storePath: string,
  lastSize: number,
): { hasNew: boolean; currentSize: number } {
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    if (!entry?.sessionId) {
      return { hasNew: false, currentSize: lastSize };
    }

    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry);
    const stat = fs.statSync(transcriptPath);
    const currentSize = stat.size;
    if (currentSize <= lastSize) {
      return { hasNew: false, currentSize };
    }

    // Read only the new bytes
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(currentSize - lastSize);
      fs.readSync(fd, buffer, 0, buffer.length, lastSize);
      const newContent = buffer.toString("utf-8");
      const lines = newContent.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const content = parsed.content;
          // Extract text from the entry
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((c: Record<string, unknown>) => c.type === "text")
              .map((c: Record<string, unknown>) => c.text)
              .join("");
          }
          // Skip HEARTBEAT_OK-only lines
          if (text.trim() === HEARTBEAT_TOKEN) {
            continue;
          }
          if (text.includes(HEARTBEAT_TOKEN) && text.replace(HEARTBEAT_TOKEN, "").trim() === "") {
            continue;
          }
          // Any other non-empty content counts as real activity
          if (text.trim()) {
            return { hasNew: true, currentSize };
          }
        } catch {
          // Malformed JSON line — skip
        }
      }
      return { hasNew: false, currentSize };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { hasNew: false, currentSize: lastSize };
  }
}

// ---------------------------------------------------------------------------
// Core check loop
// ---------------------------------------------------------------------------

async function checkAndMaybeRemind(sessionKey: string): Promise<void> {
  const state = activeReminders.get(sessionKey);
  if (!state) {
    return;
  }

  // Skip if there are requests in flight
  const queueSize = getQueueSize(CommandLane.Main);
  if (queueSize > 0) {
    log.debug("requests in flight, rescheduling", { sessionKey, queueSize });
    state.timer = setTimeout(() => {
      void checkAndMaybeRemind(sessionKey);
    }, state.timeoutMs);
    state.timer.unref?.();
    return;
  }

  // Check transcript for new non-HEARTBEAT_OK content
  const { hasNew, currentSize } = hasNewNonHeartbeatContent(
    sessionKey,
    state.storePath,
    state.lastTranscriptSize,
  );

  if (hasNew) {
    // New real activity detected — reset timer + count
    log.debug("new activity detected, resetting", { sessionKey });
    state.lastTranscriptSize = currentSize;
    state.count = 0;
    state.timer = setTimeout(() => {
      void checkAndMaybeRemind(sessionKey);
    }, state.timeoutMs);
    state.timer.unref?.();
    return;
  }

  // Max reminders reached — stop
  if (state.count >= MAX_REMIND_COUNT) {
    log.info("max reminders reached", { sessionKey, count: state.count });
    activeReminders.delete(sessionKey);
    return;
  }

  // Session idle — send simulated heartbeat (bypass heartbeat-runner)
  log.info("session idle, sending simulated heartbeat", {
    sessionKey,
    count: state.count,
  });

  try {
    await sendSimulatedHeartbeat(sessionKey, state.storePath, state.lastReplyTexts);
  } catch (err) {
    log.error("simulated heartbeat failed", { sessionKey, error: String(err) });
  }

  // Increment count and schedule next cycle
  state.count++;
  state.lastTranscriptSize = resolveTranscriptSize(sessionKey, state.storePath);

  if (state.count < MAX_REMIND_COUNT) {
    state.timer = setTimeout(() => {
      void checkAndMaybeRemind(sessionKey);
    }, state.timeoutMs);
    state.timer.unref?.();
  } else {
    activeReminders.delete(sessionKey);
  }
}

// ---------------------------------------------------------------------------
// Simulated heartbeat: getReplyFromConfig + deliverOutboundPayloads
// ---------------------------------------------------------------------------

async function sendSimulatedHeartbeat(
  sessionKey: string,
  storePath: string,
  lastReplyTexts: string[],
): Promise<void> {
  const cfg: OpenClawConfig = loadConfig();
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    log.warn("session entry not found", { sessionKey });
    return;
  }

  // Resolve delivery target from session entry (lastChannel/lastTo/lastAccountId)
  const delivery = resolveHeartbeatDeliveryTarget({ cfg, entry });
  if (delivery.channel === "none" || !delivery.to) {
    log.info("no delivery target", { sessionKey, channel: delivery.channel });
    return;
  }

  const { sender } = resolveHeartbeatSenderContext({ cfg, entry, delivery });

  // Build idle reminder prompt with agent's last N replies for context
  const prompt = buildIdleReminderPrompt(lastReplyTexts);
  const ctx = {
    Body: prompt,
    From: sender,
    To: sender,
    Provider: "heartbeat",
    SessionKey: sessionKey,
  };

  // Call the model directly
  const replyResult = await getReplyFromConfig(ctx, { isHeartbeat: true }, cfg);
  const replyPayload = pickLastPayload(replyResult);

  if (!replyPayload || isEmpty(replyPayload)) {
    log.debug("empty reply, agent confirmed idle", { sessionKey });
    activeReminders.delete(sessionKey);
    return;
  }

  // Check if the reply is just HEARTBEAT_OK (agent says nothing to do)
  const stripped = stripHeartbeatToken(replyPayload.text, {
    mode: "heartbeat",
  });
  if (stripped.shouldSkip && !hasMedia(replyPayload)) {
    log.debug("HEARTBEAT_OK reply, agent confirmed idle", { sessionKey });
    activeReminders.delete(sessionKey);
    return;
  }

  // Deliver the reply
  const text = stripped.text || "";
  if (!text.trim() && !hasMedia(replyPayload)) {
    log.debug("stripped reply empty, skipping", { sessionKey });
    return;
  }

  const payloads: ReplyPayload[] = [];
  if (hasMedia(replyPayload)) {
    payloads.push({
      text,
      mediaUrls: replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []),
    });
  } else {
    payloads.push({ text });
  }

  await deliverOutboundPayloads({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    payloads,
  });

  // Update lastHeartbeatSentAt in session store
  const freshStore = loadSessionStore(storePath);
  const current = freshStore[sessionKey];
  if (current) {
    freshStore[sessionKey] = {
      ...current,
      lastHeartbeatSentAt: Date.now(),
    };
    await saveSessionStore(storePath, freshStore);
  }

  log.info("simulated heartbeat delivered", {
    sessionKey,
    channel: delivery.channel,
    preview: text.slice(0, 100),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the last non-empty payload from a reply result. */
function pickLastPayload(
  result: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!result) {
    return undefined;
  }
  if (!Array.isArray(result)) {
    return result;
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const p = result[i];
    if (p && (p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0))) {
      return p;
    }
  }
  return undefined;
}

function isEmpty(p: ReplyPayload): boolean {
  return !p.text && !p.mediaUrl && !(p.mediaUrls && p.mediaUrls.length > 0);
}

function hasMedia(p: ReplyPayload): boolean {
  return Boolean(p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0));
}

/**
 * Check if a session has an active idle reminder.
 */
export function hasActiveIdleReminder(sessionKey: string): boolean {
  return activeReminders.has(sessionKey);
}

/**
 * Stop all idle reminders (used for cleanup on shutdown).
 */
export function stopAllIdleReminders(): void {
  for (const [sessionKey, state] of activeReminders) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    log.debug("stopped (cleanup)", { sessionKey });
  }
  activeReminders.clear();
}

/**
 * Get the count of active idle reminders (for status/debugging).
 */
export function getActiveIdleReminderCount(): number {
  return activeReminders.size;
}

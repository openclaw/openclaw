import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";
import { resolveSlackChannelConfig } from "./channel-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackCatchupState = {
  version: 1;
  channels: Record<string, string>; // channelId -> latest processed ts
  globalTs: string; // fallback watermark
  updatedAt: string; // ISO timestamp
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATCHUP_WINDOW_SEC = 30 * 60; // 30 minutes max lookback
const CATCHUP_PER_CHANNEL_LIMIT = 20; // max messages per channel
const CATCHUP_INTER_CHANNEL_DELAY_MS = 200; // pause between channels
const WATERMARK_FLUSH_INTERVAL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// State file path helper
// ---------------------------------------------------------------------------

function resolveStateFilePath(accountId: string): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".openclaw", `slack-catchup-${accountId}.json`);
}

// ---------------------------------------------------------------------------
// Load / Save state
// ---------------------------------------------------------------------------

export async function loadCatchupState(accountId: string): Promise<SlackCatchupState | null> {
  const filePath = resolveStateFilePath(accountId);
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as SlackCatchupState;
    if (parsed.version !== 1) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCatchupState(
  accountId: string,
  state: SlackCatchupState,
): Promise<void> {
  const filePath = resolveStateFilePath(accountId);
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Watermark buffer (in-memory, flushed periodically)
// ---------------------------------------------------------------------------

/** Per-account in-memory watermark buffers. */
const watermarkBuffers = new Map<string, Record<string, string>>();

/** Active flush interval timers per account. */
const flushTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Update the in-memory watermark for a channel.
 * Only advances the watermark (never goes backwards).
 */
export function updateCatchupWatermark(channelId: string, ts: string, accountId: string): void {
  if (!channelId || !ts) {
    return;
  }
  let buffer = watermarkBuffers.get(accountId);
  if (!buffer) {
    buffer = {};
    watermarkBuffers.set(accountId, buffer);
  }
  const existing = buffer[channelId];
  if (!existing || ts > existing) {
    buffer[channelId] = ts;
  }
}

/**
 * Flush the in-memory watermark buffer to disk for a given account.
 * Merges with any existing on-disk state so concurrent flushes are safe.
 */
export async function flushCatchupWatermark(accountId: string): Promise<void> {
  const buffer = watermarkBuffers.get(accountId);
  if (!buffer || Object.keys(buffer).length === 0) {
    return;
  }

  // Take a snapshot and clear the buffer
  const snapshot = { ...buffer };
  for (const key of Object.keys(snapshot)) {
    delete buffer[key];
  }

  const existing = await loadCatchupState(accountId);
  const channels = existing?.channels ?? {};
  let globalTs = existing?.globalTs ?? "0";

  for (const [channelId, ts] of Object.entries(snapshot)) {
    const current = channels[channelId];
    if (!current || ts > current) {
      channels[channelId] = ts;
    }
    if (ts > globalTs) {
      globalTs = ts;
    }
  }

  const state: SlackCatchupState = {
    version: 1,
    channels,
    globalTs,
    updatedAt: new Date().toISOString(),
  };
  await saveCatchupState(accountId, state);
}

/**
 * Start a periodic flush timer for the given account.
 * Returns a cleanup function that stops the timer and flushes one last time.
 */
export function startWatermarkFlushTimer(accountId: string): () => Promise<void> {
  // Avoid duplicate timers
  const existingTimer = flushTimers.get(accountId);
  if (existingTimer) {
    clearInterval(existingTimer);
  }

  const timer = setInterval(() => {
    void flushCatchupWatermark(accountId).catch(() => {
      // silently ignore periodic flush errors
    });
  }, WATERMARK_FLUSH_INTERVAL_MS);

  // Ensure the timer does not prevent process exit
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
  flushTimers.set(accountId, timer);

  return async () => {
    clearInterval(timer);
    flushTimers.delete(accountId);
    await flushCatchupWatermark(accountId);
  };
}

// ---------------------------------------------------------------------------
// Startup catch-up
// ---------------------------------------------------------------------------

/**
 * Determine the list of channel IDs to scan for catch-up.
 * Uses the resolved channelsConfig from the monitor context (already resolved
 * from names to IDs by the time provider.ts calls us).
 */
function resolveChannelIdsToScan(ctx: SlackMonitorContext): string[] {
  const channels = ctx.channelsConfig;
  if (!channels) {
    return [];
  }
  const ids: string[] = [];
  for (const key of Object.keys(channels)) {
    if (key === "*") {
      continue;
    }
    // Only include keys that look like Slack channel IDs (C... or G...)
    if (/^[CG][A-Z0-9]+$/i.test(key)) {
      ids.push(key);
    }
  }
  return ids;
}

/**
 * Compute the "oldest" timestamp for the Slack API query.
 * Uses the per-channel watermark if available, falls back to globalTs,
 * then clamps to CATCHUP_WINDOW_SEC from now.
 */
function resolveOldestTs(
  channelId: string,
  state: SlackCatchupState | null,
): string {
  const now = Date.now() / 1000;
  const windowFloor = String(now - CATCHUP_WINDOW_SEC);

  if (!state) {
    return windowFloor;
  }

  const channelTs = state.channels[channelId];
  const candidate = channelTs ?? state.globalTs;

  if (!candidate || candidate === "0") {
    return windowFloor;
  }

  // Clamp: never look back further than the window
  return candidate < windowFloor ? windowFloor : candidate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PerformStartupCatchUpParams = {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
  abortSignal?: AbortSignal;
};

export async function performStartupCatchUp(
  params: PerformStartupCatchUpParams,
): Promise<void> {
  const { ctx, handleSlackMessage, abortSignal } = params;
  const runtime = ctx.runtime;
  const accountId = ctx.accountId;

  const state = await loadCatchupState(accountId);
  if (!state) {
    runtime.log?.(`slack catch-up [${accountId}]: no previous state found, skipping catch-up`);
    // Initialize state file so next restart has a baseline
    const now = String(Date.now() / 1000);
    await saveCatchupState(accountId, {
      version: 1,
      channels: {},
      globalTs: now,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const channelIds = resolveChannelIdsToScan(ctx);
  if (channelIds.length === 0) {
    runtime.log?.(`slack catch-up [${accountId}]: no channels configured, skipping`);
    return;
  }

  // Also include DM channels: list open IMs
  const dmChannelIds: string[] = [];
  if (ctx.dmEnabled) {
    try {
      let dmCursor: string | undefined;
      do {
        const dmResult = await ctx.app.client.conversations.list({
          token: ctx.botToken,
          types: "im",
          limit: 200,
          ...(dmCursor ? { cursor: dmCursor } : {}),
        });
        for (const ch of (dmResult as { channels?: Array<{ id?: string; is_open?: boolean }> })
          .channels ?? []) {
          if (ch.id) {
            dmChannelIds.push(ch.id);
          }
        }
        const next = (dmResult as { response_metadata?: { next_cursor?: string } })
          .response_metadata?.next_cursor;
        dmCursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
      } while (dmCursor);
    } catch (err) {
      runtime.error?.(`slack catch-up [${accountId}]: failed to list DM channels: ${String(err)}`);
    }
  }

  const allChannelIds = [...channelIds, ...dmChannelIds];
  let totalMessages = 0;
  let channelsScanned = 0;
  let channelsWithMessages = 0;

  runtime.log?.(
    `slack catch-up [${accountId}]: scanning ${allChannelIds.length} channels (${channelIds.length} group + ${dmChannelIds.length} DM)`,
  );

  for (const channelId of allChannelIds) {
    if (abortSignal?.aborted) {
      runtime.log?.(`slack catch-up [${accountId}]: aborted`);
      break;
    }

    const oldest = resolveOldestTs(channelId, state);
    channelsScanned++;

    try {
      const result = await ctx.app.client.conversations.history({
        token: ctx.botToken,
        channel: channelId,
        oldest,
        limit: CATCHUP_PER_CHANNEL_LIMIT,
        inclusive: false, // exclude the watermark message itself
      });

      const messages = (result.messages ?? []) as Array<{
        type?: string;
        user?: string;
        bot_id?: string;
        subtype?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        event_ts?: string;
        channel?: string;
        channel_type?: string;
        files?: unknown[];
      }>;

      if (messages.length === 0) {
        continue;
      }

      // Determine channel type and requireMention for filtering
      const channelInfo = await ctx.resolveChannelName(channelId);
      const channelType = channelInfo?.type ?? (channelId.startsWith("D") ? "im" : "channel");
      const isDm = channelType === "im";
      const channelConfig = resolveSlackChannelConfig({
        channelId,
        channelName: channelInfo?.name,
        channels: ctx.channelsConfig,
        defaultRequireMention: ctx.defaultRequireMention,
      });
      const requireMention = !isDm && (channelConfig?.requireMention ?? true);

      // Sort oldest first (Slack returns newest first)
      const sorted = [...messages].sort((a, b) => {
        const tsA = a.ts ?? "0";
        const tsB = b.ts ?? "0";
        return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
      });

      let channelCount = 0;
      for (const msg of sorted) {
        // Skip bot's own messages
        if (msg.user === ctx.botUserId) {
          continue;
        }

        // Skip subtypes except file_share
        if (msg.subtype && msg.subtype !== "file_share") {
          continue;
        }

        // For requireMention channels, only catch up messages that mention the bot
        if (requireMention && ctx.botUserId) {
          const text = msg.text ?? "";
          if (!text.includes(`<@${ctx.botUserId}>`)) {
            continue;
          }
        }

        // Build a SlackMessageEvent from the history message
        const event: SlackMessageEvent = {
          type: "message",
          user: msg.user,
          bot_id: msg.bot_id,
          subtype: msg.subtype,
          text: msg.text,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
          event_ts: msg.event_ts ?? msg.ts,
          channel: channelId,
          channel_type: channelType,
          files: msg.files as SlackMessageEvent["files"],
        };

        // Determine if the message was a mention
        const wasMentioned = ctx.botUserId
          ? Boolean(event.text?.includes(`<@${ctx.botUserId}>`))
          : false;

        try {
          await handleSlackMessage(event, {
            source: "message",
            wasMentioned,
          });
          channelCount++;
          totalMessages++;

          // Update watermark immediately for each processed message
          if (msg.ts) {
            updateCatchupWatermark(channelId, msg.ts, accountId);
          }
        } catch (err) {
          runtime.error?.(
            `slack catch-up [${accountId}]: failed to process message ${msg.ts} in ${channelId}: ${String(err)}`,
          );
        }
      }

      if (channelCount > 0) {
        channelsWithMessages++;
      }
    } catch (err) {
      runtime.error?.(
        `slack catch-up [${accountId}]: failed to fetch history for ${channelId}: ${String(err)}`,
      );
    }

    // Delay between channels to avoid rate limits
    if (channelsScanned < allChannelIds.length) {
      await sleep(CATCHUP_INTER_CHANNEL_DELAY_MS);
    }
  }

  // Flush watermarks after catch-up completes
  await flushCatchupWatermark(accountId);

  runtime.log?.(
    `slack catch-up [${accountId}]: completed — scanned ${channelsScanned} channels, dispatched ${totalMessages} messages from ${channelsWithMessages} channels`,
  );
}

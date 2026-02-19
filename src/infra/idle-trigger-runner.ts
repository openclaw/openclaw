import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OnIdleTrigger } from "../config/types.base.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { IDLE_OK_TOKEN } from "../auto-reply/tokens.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";

const log = createSubsystemLogger("gateway/idle-trigger");

export const DEFAULT_IDLE_TRIGGER_DELAY_MINUTES = 30;
export const DEFAULT_IDLE_TRIGGER_FILENAME = "IDLE.md";
export const DEFAULT_IDLE_TRIGGER_CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds

// Prompt includes the "do not infer old tasks" guardrail like heartbeat.
export const IDLE_TRIGGER_PROMPT =
  "Read IDLE.md if it exists (workspace context). Follow it strictly. " +
  "Do not infer or repeat old tasks from prior chats. " +
  "If nothing needs attention, reply IDLE_OK.";

type IdleTriggerDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    nowMs?: () => number;
  };

export type IdleTriggerRunResult =
  | { status: "ran"; durationMs: number; triggersProcessed: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type IdleTriggerEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  triggerName?: string;
  sessionKey?: string;
  to?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  channel?: string;
  silent?: boolean;
};

let lastIdleTriggerEvent: IdleTriggerEventPayload | null = null;
const listeners = new Set<(evt: IdleTriggerEventPayload) => void>();

export function emitIdleTriggerEvent(evt: Omit<IdleTriggerEventPayload, "ts">) {
  const enriched: IdleTriggerEventPayload = { ts: Date.now(), ...evt };
  lastIdleTriggerEvent = enriched;
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onIdleTriggerEvent(listener: (evt: IdleTriggerEventPayload) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLastIdleTriggerEvent(): IdleTriggerEventPayload | null {
  return lastIdleTriggerEvent;
}

/**
 * Resolve the trigger key for tracking lastIdleTriggeredAt.
 * Uses trigger name if provided, otherwise uses index.
 */
function resolveTriggerKey(trigger: OnIdleTrigger, index: number): string {
  return trigger.name?.trim() || `trigger-${index}`;
}

/**
 * Parse the delay from an OnIdleTrigger config.
 */
function parseTriggerDelayMs(trigger: OnIdleTrigger): number | null {
  try {
    const ms = parseDurationMs(trigger.after, { defaultUnit: "m" });
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Resolve triggers from config.
 */
function resolveIdleTriggers(cfg: OpenClawConfig): OnIdleTrigger[] {
  return cfg.session?.onIdle ?? [];
}

/**
 * Resolve the prompt for an idle trigger.
 * If file content is provided, includes it directly in the prompt.
 * If a custom prompt is specified, returns that (ignoring file content).
 */
function resolveIdleTriggerPrompt(trigger: OnIdleTrigger, fileContent?: string | null): string {
  // Custom prompt takes precedence
  if (trigger.prompt?.trim()) {
    return trigger.prompt.trim();
  }

  // If we have file content, include it directly in the prompt
  if (fileContent?.trim()) {
    const filename = trigger.file ?? DEFAULT_IDLE_TRIGGER_FILENAME;
    return (
      `Here is the content of ${filename}:\n\n${fileContent.trim()}\n\n` +
      "Follow these instructions strictly. " +
      "Do not infer or repeat old tasks from prior chats. " +
      "If nothing needs attention, reply IDLE_OK."
    );
  }

  // Fallback (no file content)
  return IDLE_TRIGGER_PROMPT;
}

/**
 * Check if a session should trigger for a specific idle trigger.
 *
 * Conditions:
 * 1. Session has activity (updatedAt exists)
 * 2. Session is idle (now - updatedAt > delayMs)
 * 3. New activity since last trigger: updatedAt > lastIdleTriggeredAt[triggerKey]
 */
function shouldTriggerForSession(params: {
  entry: SessionEntry;
  triggerKey: string;
  delayMs: number;
  nowMs: number;
  sessionKey?: string;
}): boolean {
  const { entry, triggerKey, delayMs, nowMs, sessionKey } = params;

  // Must have activity
  if (!entry.updatedAt) {
    return false;
  }

  // Must be idle for long enough
  const idleMs = nowMs - entry.updatedAt;
  if (idleMs < delayMs) {
    return false; // Too noisy to log - this is normal
  }

  // Check per-trigger timestamp first (new system)
  const lastTriggeredAt = entry.lastIdleTriggeredAt?.[triggerKey];
  if (typeof lastTriggeredAt === "number" && entry.updatedAt <= lastTriggeredAt) {
    return false;
  }

  log.debug("shouldTrigger: will fire", {
    sessionKey,
    triggerKey,
    updatedAt: entry.updatedAt,
    lastTriggeredAt,
    idleMs,
  });
  return true;
}

/**
 * Check if a session's origin is deliverable.
 * Uses lastChannel (or deliveryContext.channel) since origin.provider may be
 * overwritten by non-deliverable sources like "idle-trigger".
 */
function isSessionDeliverable(entry: SessionEntry): boolean {
  // Prefer lastChannel, then deliveryContext.channel, then origin.surface
  // Fall back to origin.provider for backwards compatibility, but skip if it's "idle-trigger"
  const channel =
    entry.lastChannel ??
    entry.deliveryContext?.channel ??
    entry.origin?.surface ??
    (entry.origin?.provider !== "idle-trigger" ? entry.origin?.provider : undefined);
  if (!channel) {
    return false;
  }
  return isDeliverableMessageChannel(channel);
}

/**
 * Resolve delivery target from session.
 * Uses lastChannel/lastTo/lastAccountId since origin may be overwritten.
 */
function resolveSessionDeliveryTarget(entry: SessionEntry): {
  channel: string;
  to: string | undefined;
  accountId: string | undefined;
} {
  // Prefer last* fields, then deliveryContext, then origin
  // For channel, skip origin.provider if it's "idle-trigger"
  const channel =
    entry.lastChannel ??
    entry.deliveryContext?.channel ??
    entry.origin?.surface ??
    (entry.origin?.provider !== "idle-trigger" ? entry.origin?.provider : undefined);
  const to = entry.lastTo ?? entry.deliveryContext?.to ?? entry.origin?.from;
  const accountId =
    entry.lastAccountId ?? entry.deliveryContext?.accountId ?? entry.origin?.accountId;

  return {
    channel: channel ?? "none",
    to,
    accountId,
  };
}

function resolveIdleTriggerReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      return payload;
    }
  }
  return undefined;
}

async function restoreIdleTriggerUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) {
      return;
    }
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) {
      return;
    }
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

function normalizeIdleTriggerReply(payload: ReplyPayload, responsePrefix: string | undefined) {
  const stripped = stripHeartbeatToken(payload.text, {
    mode: "heartbeat",
    maxAckChars: 300,
  });
  // Also check for IDLE_OK token
  let text = stripped.text;
  let shouldSkip = stripped.shouldSkip;
  if (text && text.includes(IDLE_OK_TOKEN)) {
    const idleStripped = text.replace(new RegExp(IDLE_OK_TOKEN, "g"), "").trim();
    if (!idleStripped) {
      shouldSkip = true;
      text = "";
    } else {
      text = idleStripped;
    }
  }

  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  if (shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

/**
 * Process a single trigger for a single session.
 */
async function processTriggerForSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  trigger: OnIdleTrigger;
  triggerKey: string;
  sessionKey: string;
  entry: SessionEntry;
  storePath: string;
  nowMs: number;
  deps?: IdleTriggerDeps;
}): Promise<{ status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed"; reason?: string }> {
  const { cfg, agentId, trigger, triggerKey, sessionKey, entry, storePath, nowMs, deps } = params;
  const startedAt = Date.now();

  // Check if IDLE file exists (if file-based trigger)
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const filename = trigger.file ?? DEFAULT_IDLE_TRIGGER_FILENAME;

  // Read file content for file-based triggers (no custom prompt)
  let idleFileContent: string | null = null;
  if (!trigger.prompt) {
    const idleFilePath = path.join(workspaceDir, filename);
    try {
      idleFileContent = await fs.readFile(idleFilePath, "utf-8");
    } catch {
      emitIdleTriggerEvent({
        status: "skipped",
        triggerName: triggerKey,
        sessionKey,
        reason: "no-idle-file",
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: "no-idle-file" };
    }

    if (!idleFileContent.trim()) {
      emitIdleTriggerEvent({
        status: "skipped",
        triggerName: triggerKey,
        sessionKey,
        reason: "empty-idle-file",
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: "empty-idle-file" };
    }
  }

  const previousUpdatedAt = entry.updatedAt;
  const delivery = resolveSessionDeliveryTarget(entry);
  const visibility =
    delivery.channel !== "none"
      ? resolveHeartbeatVisibility({
          cfg,
          channel: delivery.channel,
          accountId: delivery.accountId,
        })
      : { showOk: false, showAlerts: true, useIndicator: true };

  const sender = entry.origin?.from ?? "idle-trigger";
  const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix;
  const prompt = resolveIdleTriggerPrompt(trigger, idleFileContent);

  const ctx = {
    Body: prompt,
    From: sender,
    To: sender,
    Provider: "idle-trigger",
    SessionKey: sessionKey,
  };

  if (!visibility.showAlerts && !visibility.showOk) {
    emitIdleTriggerEvent({
      status: "skipped",
      triggerName: triggerKey,
      sessionKey,
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }

  try {
    const replyResult = await getReplyFromConfig(ctx, { isHeartbeat: true }, cfg);
    const replyPayload = resolveIdleTriggerReplyPayload(replyResult);

    // Update lastIdleTriggeredAt regardless of reply content
    await updateSessionStore(storePath, (nextStore) => {
      const current = nextStore[sessionKey];
      if (current) {
        nextStore[sessionKey] = {
          ...current,
          lastIdleTriggeredAt: {
            ...current.lastIdleTriggeredAt,
            [triggerKey]: nowMs,
          },
        };
      }
    });

    if (
      !replyPayload ||
      (!replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length)
    ) {
      await restoreIdleTriggerUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitIdleTriggerEvent({
        status: "ok-empty",
        triggerName: triggerKey,
        sessionKey,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
      });
      return { status: "ok-empty" };
    }

    const normalized = normalizeIdleTriggerReply(replyPayload, responsePrefix);
    if (normalized.shouldSkip && !normalized.hasMedia) {
      await restoreIdleTriggerUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitIdleTriggerEvent({
        status: "ok-token",
        triggerName: triggerKey,
        sessionKey,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
      });
      return { status: "ok-token" };
    }

    const mediaUrls =
      replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);

    if (delivery.channel === "none" || !delivery.to) {
      emitIdleTriggerEvent({
        status: "skipped",
        triggerName: triggerKey,
        sessionKey,
        reason: "no-target",
        preview: normalized.text?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
      });
      return { status: "skipped", reason: "no-target" };
    }

    if (!visibility.showAlerts) {
      await restoreIdleTriggerUpdatedAt({ storePath, sessionKey, updatedAt: previousUpdatedAt });
      emitIdleTriggerEvent({
        status: "skipped",
        triggerName: triggerKey,
        sessionKey,
        reason: "alerts-disabled",
        preview: normalized.text?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        channel: delivery.channel,
        hasMedia: mediaUrls.length > 0,
      });
      return { status: "skipped", reason: "alerts-disabled" };
    }

    const deliveryAccountId = delivery.accountId;
    const idlePlugin = getChannelPlugin(delivery.channel);
    if (idlePlugin?.heartbeat?.checkReady) {
      const readiness = await idlePlugin.heartbeat.checkReady({
        cfg,
        accountId: deliveryAccountId,
        deps,
      });
      if (!readiness.ok) {
        emitIdleTriggerEvent({
          status: "skipped",
          triggerName: triggerKey,
          sessionKey,
          reason: readiness.reason,
          preview: normalized.text?.slice(0, 200),
          durationMs: Date.now() - startedAt,
          hasMedia: mediaUrls.length > 0,
          channel: delivery.channel,
        });
        log.info("idle-trigger: channel not ready", {
          channel: delivery.channel,
          reason: readiness.reason,
          triggerKey,
          sessionKey,
        });
        return { status: "skipped", reason: readiness.reason };
      }
    }

    await deliverOutboundPayloads({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: deliveryAccountId,
      payloads: [
        {
          text: normalized.text,
          mediaUrls,
        },
      ],
      deps,
    });

    // Update lastIdleTriggeredAt with current time AFTER delivery completes.
    // This ensures it's >= the bumped updatedAt from getReplyFromConfig,
    // preventing the trigger from re-firing until the user sends a new message.
    await updateSessionStore(storePath, (nextStore) => {
      const current = nextStore[sessionKey];
      if (current) {
        nextStore[sessionKey] = {
          ...current,
          lastIdleTriggeredAt: {
            ...current.lastIdleTriggeredAt,
            [triggerKey]: Date.now(),
          },
        };
      }
    });

    emitIdleTriggerEvent({
      status: "sent",
      triggerName: triggerKey,
      sessionKey,
      to: delivery.to,
      preview: normalized.text?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
      channel: delivery.channel,
    });
    return { status: "sent" };
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitIdleTriggerEvent({
      status: "failed",
      triggerName: triggerKey,
      sessionKey,
      reason,
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
    });
    log.error(`idle-trigger failed: ${reason}`, {
      error: reason,
      triggerKey,
      sessionKey,
    });
    return { status: "failed", reason };
  }
}

export async function runIdleTriggerOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  deps?: IdleTriggerDeps;
}): Promise<IdleTriggerRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const triggers = resolveIdleTriggers(cfg);

  if (triggers.length === 0) {
    return { status: "skipped", reason: "disabled" };
  }

  const nowMs = opts.deps?.nowMs?.() ?? Date.now();
  const startedAt = nowMs;

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  // Load ALL sessions
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const sessionKeys = Object.keys(store);

  if (sessionKeys.length === 0) {
    return { status: "skipped", reason: "no-sessions" };
  }

  let triggersProcessed = 0;

  // Process each trigger against each session
  for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex++) {
    const trigger = triggers[triggerIndex];
    const triggerKey = resolveTriggerKey(trigger, triggerIndex);
    const delayMs = parseTriggerDelayMs(trigger);

    if (!delayMs) {
      log.warn(`idle-trigger: invalid delay for trigger ${triggerKey}: ${trigger.after}`);
      continue;
    }

    for (const sessionKey of sessionKeys) {
      const entry = store[sessionKey];
      if (!entry) {
        continue;
      }

      // Skip sessions without deliverable origin (e.g. cron sessions)
      if (!isSessionDeliverable(entry)) {
        continue;
      }

      // Check if this session should trigger
      if (!shouldTriggerForSession({ entry, triggerKey, delayMs, nowMs, sessionKey })) {
        continue;
      }

      // Process the trigger for this session
      const result = await processTriggerForSession({
        cfg,
        agentId,
        trigger,
        triggerKey,
        sessionKey,
        entry,
        storePath,
        nowMs,
        deps: opts.deps,
      });

      if (result.status !== "skipped") {
        triggersProcessed++;
      }
    }
  }

  return { status: "ran", durationMs: Date.now() - startedAt, triggersProcessed };
}

export type IdleTriggerRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export function startIdleTriggerRunner(opts: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  runOnce?: typeof runIdleTriggerOnce;
}): IdleTriggerRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runIdleTriggerOnce;
  const state = {
    cfg: opts.cfg ?? loadConfig(),
    runtime,
    timer: null as NodeJS.Timeout | null,
    stopped: false,
  };
  let initialized = false;

  const hasEnabledTriggers = (cfg: OpenClawConfig): boolean => {
    return resolveIdleTriggers(cfg).length > 0;
  };

  const getMinDelayMs = (cfg: OpenClawConfig): number | null => {
    const triggers = resolveIdleTriggers(cfg);
    if (triggers.length === 0) {
      return null;
    }
    let minDelay: number | null = null;
    for (const trigger of triggers) {
      const delayMs = parseTriggerDelayMs(trigger);
      if (delayMs && (minDelay === null || delayMs < minDelay)) {
        minDelay = delayMs;
      }
    }
    return minDelay;
  };

  const scheduleNext = () => {
    if (state.stopped) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const minDelayMs = getMinDelayMs(state.cfg);
    if (!minDelayMs) {
      return;
    }

    // Check periodically (every minute or sooner)
    const checkInterval = Math.min(DEFAULT_IDLE_TRIGGER_CHECK_INTERVAL_MS, minDelayMs / 2);
    state.timer = setTimeout(async () => {
      if (state.stopped) {
        return;
      }
      try {
        await runOnce({
          cfg: state.cfg,
          deps: { runtime },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        runtime.error(`idle-trigger: runOnce threw unexpectedly: ${errMsg}`);
      }
      scheduleNext();
    }, checkInterval);
    state.timer.unref?.();
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const wasEnabled = hasEnabledTriggers(state.cfg);
    state.cfg = cfg;
    const isEnabled = hasEnabledTriggers(cfg);

    if (!initialized) {
      const triggers = resolveIdleTriggers(cfg);
      if (isEnabled) {
        const minDelayMs = getMinDelayMs(cfg);
        log.info("idle-trigger: started", {
          triggerCount: triggers.length,
          minDelayMs,
        });
      } else {
        log.info("idle-trigger: disabled", { enabled: false });
      }
      initialized = true;
    } else if (wasEnabled !== isEnabled) {
      if (isEnabled) {
        const triggers = resolveIdleTriggers(cfg);
        const minDelayMs = getMinDelayMs(cfg);
        log.info("idle-trigger: started", {
          triggerCount: triggers.length,
          minDelayMs,
        });
      } else {
        log.info("idle-trigger: disabled", { enabled: false });
      }
    }

    scheduleNext();
  };

  const cleanup = () => {
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
  };

  updateConfig(state.cfg);
  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup, updateConfig };
}

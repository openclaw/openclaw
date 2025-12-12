import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
  updateLastRoute,
} from "../config/sessions.js";
import { danger, isVerbose, logVerbose, success } from "../globals.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { getQueueSize } from "../process/command-queue.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { jidToE164, normalizeE164 } from "../utils.js";
import { setActiveWebListener } from "./active-listener.js";
import { monitorWebInbox } from "./inbound.js";
import { loadWebMedia } from "./media.js";
import { sendMessageWhatsApp } from "./outbound.js";
import {
  computeBackoff,
  newConnectionId,
  type ReconnectPolicy,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "./reconnect.js";
import { formatError, getWebAuthAgeMs, readWebSelfId } from "./session.js";

const WEB_TEXT_LIMIT = 4000;
const DEFAULT_GROUP_HISTORY_LIMIT = 50;

let heartbeatsEnabled = true;
export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

// Send via the active gateway-backed listener. The monitor already owns the single
// Baileys session, so use its send API directly.
async function sendWithIpcFallback(
  to: string,
  message: string,
  opts: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  return sendMessageWhatsApp(to, message, opts);
}

const DEFAULT_WEB_MEDIA_BYTES = 5 * 1024 * 1024;
type WebInboundMsg = Parameters<
  typeof monitorWebInbox
>[0]["onMessage"] extends (msg: infer M) => unknown
  ? M
  : never;

export type WebMonitorTuning = {
  reconnect?: Partial<ReconnectPolicy>;
  heartbeatSeconds?: number;
  replyHeartbeatMinutes?: number;
  replyHeartbeatNow?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

const DEFAULT_REPLY_HEARTBEAT_MINUTES = 30;
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const HEARTBEAT_PROMPT = "HEARTBEAT /think:high";

function elide(text?: string, limit = 400) {
  if (!text) return text;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated ${text.length - limit} chars)`;
}

type MentionConfig = {
  requireMention: boolean;
  mentionRegexes: RegExp[];
};

function buildMentionConfig(cfg: ReturnType<typeof loadConfig>): MentionConfig {
  const gc = cfg.inbound?.groupChat;
  const requireMention = gc?.requireMention !== false; // default true
  const mentionRegexes =
    gc?.mentionPatterns
      ?.map((p) => {
        try {
          return new RegExp(p, "i");
        } catch {
          return null;
        }
      })
      .filter((r): r is RegExp => Boolean(r)) ?? [];
  return { requireMention, mentionRegexes };
}

function isBotMentioned(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
): boolean {
  const clean = (text: string) =>
    text
      // Remove zero-width and directionality markers WhatsApp injects around display names
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
      .toLowerCase();

  if (msg.mentionedJids?.length) {
    const normalizedMentions = msg.mentionedJids
      .map((jid) => jidToE164(jid) ?? jid)
      .filter(Boolean);
    if (msg.selfE164 && normalizedMentions.includes(msg.selfE164)) return true;
    if (msg.selfJid && msg.selfE164) {
      // Some mentions use the bare JID; match on E.164 to be safe.
      const bareSelf = msg.selfJid.replace(/:\\d+/, "");
      if (normalizedMentions.includes(bareSelf)) return true;
    }
  }
  const bodyClean = clean(msg.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) return true;

  // Fallback: detect body containing our own number (with or without +, spacing)
  if (msg.selfE164) {
    const selfDigits = msg.selfE164.replace(/\D/g, "");
    if (selfDigits) {
      const bodyDigits = bodyClean.replace(/[^\d]/g, "");
      if (bodyDigits.includes(selfDigits)) return true;
      const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
      const pattern = new RegExp(`\\+?${selfDigits}`, "i");
      if (pattern.test(bodyNoSpace)) return true;
    }
  }

  return false;
}

function debugMention(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
): { wasMentioned: boolean; details: Record<string, unknown> } {
  const result = isBotMentioned(msg, mentionCfg);
  const details = {
    from: msg.from,
    body: msg.body,
    bodyClean: msg.body
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
      .toLowerCase(),
    mentionedJids: msg.mentionedJids ?? null,
    selfJid: msg.selfJid ?? null,
    selfE164: msg.selfE164 ?? null,
  };
  return { wasMentioned: result, details };
}

export function resolveReplyHeartbeatMinutes(
  cfg: ReturnType<typeof loadConfig>,
  overrideMinutes?: number,
) {
  const raw = overrideMinutes ?? cfg.inbound?.reply?.heartbeatMinutes;
  if (raw === 0) return null;
  if (typeof raw === "number" && raw > 0) return raw;
  return cfg.inbound?.reply?.mode === "command"
    ? DEFAULT_REPLY_HEARTBEAT_MINUTES
    : null;
}

export function stripHeartbeatToken(raw?: string) {
  if (!raw) return { shouldSkip: true, text: "" };
  const trimmed = raw.trim();
  if (!trimmed) return { shouldSkip: true, text: "" };
  if (trimmed === HEARTBEAT_TOKEN) return { shouldSkip: true, text: "" };
  const withoutToken = trimmed.replaceAll(HEARTBEAT_TOKEN, "").trim();
  return {
    shouldSkip: withoutToken.length === 0,
    text: withoutToken || trimmed,
  };
}

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof loadConfig>;
  to: string;
  verbose?: boolean;
  replyResolver?: typeof getReplyFromConfig;
  runtime?: RuntimeEnv;
  sender?: typeof sendMessageWhatsApp;
  sessionId?: string;
  overrideBody?: string;
  dryRun?: boolean;
}) {
  const {
    cfg: cfgOverride,
    to,
    verbose = false,
    sessionId,
    overrideBody,
    dryRun = false,
  } = opts;
  const _runtime = opts.runtime ?? defaultRuntime;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendWithIpcFallback;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = cfgOverride ?? loadConfig();
  const sessionCfg = cfg.inbound?.reply?.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = sessionCfg?.mainKey;
  const sessionKey = resolveSessionKey(sessionScope, { From: to }, mainKey);
  if (sessionId) {
    const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
    const store = loadSessionStore(storePath);
    store[sessionKey] = {
      ...(store[sessionKey] ?? {}),
      sessionId,
      updatedAt: Date.now(),
    };
    await saveSessionStore(storePath, store);
  }
  const sessionSnapshot = getSessionSnapshot(cfg, to, true);
  if (verbose) {
    heartbeatLogger.info(
      {
        to,
        sessionKey: sessionSnapshot.key,
        sessionId: sessionId ?? sessionSnapshot.entry?.sessionId ?? null,
        sessionFresh: sessionSnapshot.fresh,
        idleMinutes: sessionSnapshot.idleMinutes,
      },
      "heartbeat session snapshot",
    );
  }

  if (overrideBody && overrideBody.trim().length === 0) {
    throw new Error("Override body must be non-empty when provided.");
  }

  try {
    if (overrideBody) {
      if (dryRun) {
        console.log(
          success(
            `[dry-run] web send -> ${to}: ${overrideBody.trim()} (manual message)`,
          ),
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose });
      emitHeartbeatEvent({
        status: "sent",
        to,
        preview: overrideBody.slice(0, 160),
        hasMedia: false,
      });
      heartbeatLogger.info(
        {
          to,
          messageId: sendResult.messageId,
          chars: overrideBody.length,
          reason: "manual-message",
        },
        "manual heartbeat message sent",
      );
      console.log(
        success(
          `sent manual message to ${to} (web), id ${sendResult.messageId}`,
        ),
      );
      return;
    }

    const replyResult = await replyResolver(
      {
        Body: HEARTBEAT_PROMPT,
        From: to,
        To: to,
        MessageSid: sessionId ?? sessionSnapshot.entry?.sessionId,
      },
      { isHeartbeat: true },
      cfg,
    );
    const replyPayload = Array.isArray(replyResult)
      ? replyResult[0]
      : replyResult;

    if (
      !replyPayload ||
      (!replyPayload.text &&
        !replyPayload.mediaUrl &&
        !replyPayload.mediaUrls?.length)
    ) {
      heartbeatLogger.info(
        {
          to,
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
        },
        "heartbeat skipped",
      );
      if (verbose) console.log(success("heartbeat: ok (empty reply)"));
      emitHeartbeatEvent({ status: "ok-empty", to });
      return;
    }

    const hasMedia = Boolean(
      replyPayload.mediaUrl || (replyPayload.mediaUrls?.length ?? 0) > 0,
    );
    const stripped = stripHeartbeatToken(replyPayload.text);
    if (stripped.shouldSkip && !hasMedia) {
      // Don't let heartbeats keep sessions alive: restore previous updatedAt so idle expiry still works.
      const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
      const store = loadSessionStore(storePath);
      if (sessionSnapshot.entry && store[sessionSnapshot.key]) {
        store[sessionSnapshot.key].updatedAt = sessionSnapshot.entry.updatedAt;
        await saveSessionStore(storePath, store);
      }

      heartbeatLogger.info(
        { to, reason: "heartbeat-token", rawLength: replyPayload.text?.length },
        "heartbeat skipped",
      );
      console.log(success("heartbeat: ok (HEARTBEAT_OK)"));
      emitHeartbeatEvent({ status: "ok-token", to });
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn(
        { to },
        "heartbeat reply contained media; sending text only",
      );
    }

    const finalText = stripped.text || replyPayload.text || "";
    if (dryRun) {
      heartbeatLogger.info(
        { to, reason: "dry-run", chars: finalText.length },
        "heartbeat dry-run",
      );
      console.log(
        success(`[dry-run] heartbeat -> ${to}: ${finalText.slice(0, 200)}`),
      );
      return;
    }

    const sendResult = await sender(to, finalText, { verbose });
    emitHeartbeatEvent({
      status: "sent",
      to,
      preview: finalText.slice(0, 160),
      hasMedia,
    });
    heartbeatLogger.info(
      {
        to,
        messageId: sendResult.messageId,
        chars: finalText.length,
        preview: elide(finalText, 140),
      },
      "heartbeat sent",
    );
    console.log(success(`heartbeat: alert sent to ${to}`));
  } catch (err) {
    const reason = String(err);
    heartbeatLogger.warn({ to, error: reason }, "heartbeat failed");
    console.log(danger(`heartbeat: failed - ${reason}`));
    emitHeartbeatEvent({ status: "failed", to, reason: String(err) });
    throw err;
  }
}

function getFallbackRecipient(cfg: ReturnType<typeof loadConfig>) {
  const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
  const store = loadSessionStore(storePath);
  const candidates = Object.entries(store).filter(([key]) => key !== "global");
  if (candidates.length === 0) {
    const allowFrom =
      Array.isArray(cfg.inbound?.allowFrom) && cfg.inbound.allowFrom.length > 0
        ? cfg.inbound.allowFrom.filter((v) => v !== "*")
        : [];
    if (allowFrom.length === 0) return null;
    return allowFrom[0] ? normalizeE164(allowFrom[0]) : null;
  }
  const mostRecent = candidates.sort(
    (a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0),
  )[0];
  return mostRecent ? normalizeE164(mostRecent[0]) : null;
}

function getSessionRecipients(cfg: ReturnType<typeof loadConfig>) {
  const sessionCfg = cfg.inbound?.reply?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  if (scope === "global") return [];
  const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
  const store = loadSessionStore(storePath);
  return Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({
      to: normalizeE164(key),
      updatedAt: entry?.updatedAt ?? 0,
    }))
    .filter(({ to }) => Boolean(to))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean } = {},
) {
  if (opts.to) return { recipients: [normalizeE164(opts.to)], source: "flag" };

  const sessionRecipients = getSessionRecipients(cfg);
  const allowFrom =
    Array.isArray(cfg.inbound?.allowFrom) && cfg.inbound.allowFrom.length > 0
      ? cfg.inbound.allowFrom.filter((v) => v !== "*").map(normalizeE164)
      : [];

  const unique = (list: string[]) => [...new Set(list.filter(Boolean))];

  if (opts.all) {
    const all = unique([...sessionRecipients.map((s) => s.to), ...allowFrom]);
    return { recipients: all, source: "all" as const };
  }

  if (sessionRecipients.length === 1) {
    return { recipients: [sessionRecipients[0].to], source: "session-single" };
  }
  if (sessionRecipients.length > 1) {
    return {
      recipients: sessionRecipients.map((s) => s.to),
      source: "session-ambiguous" as const,
    };
  }

  return { recipients: allowFrom, source: "allowFrom" as const };
}

function getSessionSnapshot(
  cfg: ReturnType<typeof loadConfig>,
  from: string,
  isHeartbeat = false,
) {
  const sessionCfg = cfg.inbound?.reply?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key = resolveSessionKey(
    scope,
    { From: from, To: "", Body: "" },
    sessionCfg?.mainKey,
  );
  const store = loadSessionStore(resolveStorePath(sessionCfg?.store));
  const entry = store[key];
  const idleMinutes = Math.max(
    (isHeartbeat
      ? (sessionCfg?.heartbeatIdleMinutes ?? sessionCfg?.idleMinutes)
      : sessionCfg?.idleMinutes) ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const fresh = !!(
    entry && Date.now() - entry.updatedAt <= idleMinutes * 60_000
  );
  return { key, entry, fresh, idleMinutes };
}

async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  maxMediaBytes: number;
  replyLogger: ReturnType<typeof getChildLogger>;
  runtime: RuntimeEnv;
  connectionId?: string;
  skipLog?: boolean;
}) {
  const {
    replyResult,
    msg,
    maxMediaBytes,
    replyLogger,
    runtime,
    connectionId,
    skipLog,
  } = params;
  const replyStarted = Date.now();
  const textChunks = chunkText(replyResult.text || "", WEB_TEXT_LIMIT);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const sendWithRetry = async (
    fn: () => Promise<unknown>,
    label: string,
    maxAttempts = 3,
  ) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const isLast = attempt === maxAttempts;
        const shouldRetry = /closed|reset|timed\s*out|disconnect/i.test(
          String(err ?? ""),
        );
        if (!shouldRetry || isLast) {
          throw err;
        }
        const backoffMs = 500 * attempt;
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${String(
            err,
          )}`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    for (const chunk of textChunks) {
      await sendWithRetry(() => msg.reply(chunk), "text");
    }
    if (!skipLog) {
      logInfo(
        `✅ Sent web reply to ${msg.from} (${(Date.now() - replyStarted).toFixed(0)}ms)`,
        runtime,
      );
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: elide(replyResult.text, 240),
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    return;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  for (const [index, mediaUrl] of mediaList.entries()) {
    const caption =
      index === 0 ? remainingText.shift() || undefined : undefined;
    try {
      const media = await loadWebMedia(mediaUrl, maxMediaBytes);
      if (isVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(
          `Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`,
        );
      }
      if (media.kind === "image") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              image: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:image",
        );
      } else if (media.kind === "audio") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              audio: media.buffer,
              ptt: true,
              mimetype: media.contentType,
              caption,
            }),
          "media:audio",
        );
      } else if (media.kind === "video") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              video: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:video",
        );
      } else {
        const fileName = mediaUrl.split("/").pop() ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        await sendWithRetry(
          () =>
            msg.sendMedia({
              document: media.buffer,
              fileName,
              caption,
              mimetype,
            }),
          "media:document",
        );
      }
      logInfo(
        `✅ Sent web media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
        runtime,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    } catch (err) {
      console.error(
        danger(`Failed sending web media to ${msg.from}: ${String(err)}`),
      );
      replyLogger.warn({ err, mediaUrl }, "failed to send web media reply");
      if (index === 0) {
        const warning =
          err instanceof Error
            ? `⚠️ Media failed: ${err.message}`
            : "⚠️ Media failed.";
        const fallbackTextParts = [
          remainingText.shift() ?? caption ?? "",
          warning,
        ].filter(Boolean);
        const fallbackText = fallbackTextParts.join("\n");
        if (fallbackText) {
          console.log(`⚠️  Media skipped; sent text-only to ${msg.from}`);
          await msg.reply(fallbackText);
        }
      }
    }
  }

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    await msg.reply(chunk);
  }
}

export async function monitorWebProvider(
  verbose: boolean,
  listenerFactory: typeof monitorWebInbox | undefined = monitorWebInbox,
  keepAlive = true,
  replyResolver: typeof getReplyFromConfig | undefined = getReplyFromConfig,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const heartbeatLogger = getChildLogger({ module: "web-heartbeat", runId });
  const reconnectLogger = getChildLogger({ module: "web-reconnect", runId });
  const cfg = loadConfig();
  const configuredMaxMb = cfg.inbound?.reply?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const heartbeatSeconds = resolveHeartbeatSeconds(
    cfg,
    tuning.heartbeatSeconds,
  );
  const replyHeartbeatMinutes = resolveReplyHeartbeatMinutes(
    cfg,
    tuning.replyHeartbeatMinutes,
  );
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const mentionConfig = buildMentionConfig(cfg);
  const groupHistoryLimit =
    cfg.inbound?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  const groupHistories = new Map<
    string,
    Array<{ sender: string; body: string; timestamp?: number }>
  >();
  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  // Avoid noisy MaxListenersExceeded warnings in test environments where
  // multiple gateway instances may be constructed.
  const currentMaxListeners = process.getMaxListeners?.() ?? 10;
  if (process.setMaxListeners && currentMaxListeners < 50) {
    process.setMaxListeners(50);
  }

  let sigintStop = false;
  const handleSigint = () => {
    sigintStop = true;
  };
  process.once("SIGINT", handleSigint);

  let reconnectAttempts = 0;

  // Track recently sent messages to prevent echo loops
  const recentlySent = new Set<string>();
  const MAX_RECENT_MESSAGES = 100;

  while (true) {
    if (stopRequested()) break;

    const connectionId = newConnectionId();
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let replyHeartbeatTimer: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let lastInboundMsg: WebInboundMsg | null = null;

    // Watchdog to detect stuck message processing (e.g., event emitter died)
    // Should be significantly longer than heartbeatMinutes to avoid false positives
    const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes without any messages
    const WATCHDOG_CHECK_MS = 60 * 1000; // Check every minute

    // Batch inbound messages per conversation while command queue is busy.
    type PendingBatch = { messages: WebInboundMsg[]; timer?: NodeJS.Timeout };
    const pendingBatches = new Map<string, PendingBatch>();
    const backgroundTasks = new Set<Promise<unknown>>();

    const buildLine = (msg: WebInboundMsg) => {
      // Build message prefix: explicit config > default based on allowFrom
      let messagePrefix = cfg.inbound?.messagePrefix;
      if (messagePrefix === undefined) {
        const hasAllowFrom = (cfg.inbound?.allowFrom?.length ?? 0) > 0;
        messagePrefix = hasAllowFrom ? "" : "[clawdis]";
      }
      const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
      const senderLabel =
        msg.chatType === "group"
          ? `${msg.senderName ?? msg.senderE164 ?? "Someone"}: `
          : "";
      const baseLine = `${prefixStr}${senderLabel}${msg.body}`;

      // Wrap with standardized envelope for the agent.
      return formatAgentEnvelope({
        surface: "WhatsApp",
        from:
          msg.chatType === "group"
            ? msg.from
            : msg.from?.replace(/^whatsapp:/, ""),
        timestamp: msg.timestamp,
        body: baseLine,
      });
    };

    const processBatch = async (conversationId: string) => {
      const batch = pendingBatches.get(conversationId);
      if (!batch || batch.messages.length === 0) return;
      if (getQueueSize() > 0) {
        batch.timer = setTimeout(() => processBatch(conversationId), 150);
        return;
      }
      pendingBatches.delete(conversationId);

      const messages = batch.messages;
      const latest = messages[messages.length - 1];
      let combinedBody = messages.map(buildLine).join("\n");

      if (latest.chatType === "group") {
        const history = groupHistories.get(conversationId) ?? [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((m) =>
              formatAgentEnvelope({
                surface: "WhatsApp",
                from: conversationId,
                timestamp: m.timestamp,
                body: `${m.sender}: ${m.body}`,
              }),
            )
            .join("\\n");
          combinedBody = `[Chat messages since your last reply - for context]\\n${historyText}\\n\\n[Current message - respond to this]\\n${buildLine(latest)}`;
        }
        // Always surface who sent the triggering message so the agent can address them.
        const senderLabel =
          latest.senderName && latest.senderE164
            ? `${latest.senderName} (${latest.senderE164})`
            : (latest.senderName ?? latest.senderE164 ?? "Unknown");
        combinedBody = `${combinedBody}\\n[from: ${senderLabel}]`;
        // Clear stored history after using it
        groupHistories.set(conversationId, []);
      }

      // Echo detection uses combined body so we don't respond twice.
      if (recentlySent.has(combinedBody)) {
        logVerbose(`Skipping auto-reply: detected echo for combined batch`);
        recentlySent.delete(combinedBody);
        return;
      }

      const correlationId = latest.id ?? newConnectionId();
      replyLogger.info(
        {
          connectionId,
          correlationId,
          from: latest.chatType === "group" ? conversationId : latest.from,
          to: latest.to,
          body: elide(combinedBody, 240),
          mediaType: latest.mediaType ?? null,
          mediaPath: latest.mediaPath ?? null,
          batchSize: messages.length,
        },
        "inbound web message (batched)",
      );

      const tsDisplay = latest.timestamp
        ? new Date(latest.timestamp).toISOString()
        : new Date().toISOString();
      const fromDisplay =
        latest.chatType === "group" ? conversationId : latest.from;
      console.log(
        `\n[${tsDisplay}] ${fromDisplay} -> ${latest.to}: ${combinedBody}`,
      );

      if (latest.chatType !== "group") {
        const sessionCfg = cfg.inbound?.reply?.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        const to = (() => {
          if (latest.senderE164) return normalizeE164(latest.senderE164);
          // In direct chats, `latest.from` is already the canonical conversation id,
          // which is an E.164 string (e.g. "+1555"). Only fall back to JID parsing
          // when we were handed a JID-like string.
          if (latest.from.includes("@")) return jidToE164(latest.from);
          return normalizeE164(latest.from);
        })();
        if (to) {
          const task = updateLastRoute({
            storePath,
            sessionKey: mainKey,
            channel: "whatsapp",
            to,
          }).catch((err) => {
            replyLogger.warn(
              { error: String(err), storePath, sessionKey: mainKey, to },
              "failed updating last route",
            );
          });
          backgroundTasks.add(task);
          task.finally(() => {
            backgroundTasks.delete(task);
          });
        }
      }

      const replyResult = await (replyResolver ?? getReplyFromConfig)(
        {
          Body: combinedBody,
          From: latest.from,
          To: latest.to,
          MessageSid: latest.id,
          MediaPath: latest.mediaPath,
          MediaUrl: latest.mediaUrl,
          MediaType: latest.mediaType,
          ChatType: latest.chatType,
          GroupSubject: latest.groupSubject,
          GroupMembers: latest.groupParticipants?.join(", "),
          SenderName: latest.senderName,
          SenderE164: latest.senderE164,
          Surface: "whatsapp",
        },
        {
          onReplyStart: latest.sendComposing,
        },
      );

      const replyList = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];

      if (replyList.length === 0) {
        logVerbose("Skipping auto-reply: no text/media returned from resolver");
        return;
      }

      // Apply response prefix if configured (skip for HEARTBEAT_OK to preserve exact match)
      const responsePrefix = cfg.inbound?.responsePrefix;

      for (const replyPayload of replyList) {
        if (
          responsePrefix &&
          replyPayload.text &&
          replyPayload.text.trim() !== HEARTBEAT_TOKEN &&
          !replyPayload.text.startsWith(responsePrefix)
        ) {
          replyPayload.text = `${responsePrefix} ${replyPayload.text}`;
        }

        try {
          await deliverWebReply({
            replyResult: replyPayload,
            msg: latest,
            maxMediaBytes,
            replyLogger,
            runtime,
            connectionId,
          });

          if (replyPayload.text) {
            recentlySent.add(replyPayload.text);
            recentlySent.add(combinedBody); // Prevent echo on the batch text itself
            logVerbose(
              `Added to echo detection set (size now: ${recentlySent.size}): ${replyPayload.text.substring(0, 50)}...`,
            );
            if (recentlySent.size > MAX_RECENT_MESSAGES) {
              const firstKey = recentlySent.values().next().value;
              if (firstKey) recentlySent.delete(firstKey);
            }
          }

          const fromDisplay =
            latest.chatType === "group"
              ? conversationId
              : (latest.from ?? "unknown");
          if (isVerbose()) {
            console.log(
              success(
                `↩️  Auto-replied to ${fromDisplay} (web${replyPayload.mediaUrl || replyPayload.mediaUrls?.length ? ", media" : ""}; batched ${messages.length})`,
              ),
            );
          } else {
            console.log(
              success(
                `↩️  ${replyPayload.text ?? "<media>"}${replyPayload.mediaUrl || replyPayload.mediaUrls?.length ? " (media)" : ""}`,
              ),
            );
          }
        } catch (err) {
          console.error(
            danger(
              `Failed sending web auto-reply to ${latest.from ?? conversationId}: ${String(err)}`,
            ),
          );
        }
      }
    };

    const enqueueBatch = async (msg: WebInboundMsg) => {
      const key = msg.conversationId ?? msg.from;
      const bucket = pendingBatches.get(key) ?? { messages: [] };
      bucket.messages.push(msg);
      pendingBatches.set(key, bucket);
      if (getQueueSize() === 0) {
        await processBatch(key);
      } else {
        bucket.timer = bucket.timer ?? setTimeout(() => processBatch(key), 150);
      }
    };

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      onMessage: async (msg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        lastInboundMsg = msg;
        const conversationId = msg.conversationId ?? msg.from;

        // Same-phone mode logging retained
        if (msg.from === msg.to) {
          logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
        }

        // Skip if this is a message we just sent (echo detection)
        if (recentlySent.has(msg.body)) {
          console.log(`⏭️  Skipping echo: detected recently sent message`);
          logVerbose(
            `Skipping auto-reply: detected echo (message matches recently sent text)`,
          );
          recentlySent.delete(msg.body);
          return;
        }

        if (msg.chatType === "group") {
          const history =
            groupHistories.get(conversationId) ??
            ([] as Array<{ sender: string; body: string; timestamp?: number }>);
          history.push({
            sender: msg.senderName ?? msg.senderE164 ?? "Unknown",
            body: msg.body,
            timestamp: msg.timestamp,
          });
          while (history.length > groupHistoryLimit) history.shift();
          groupHistories.set(conversationId, history);

          const mentionDebug = debugMention(msg, mentionConfig);
          replyLogger.debug(
            {
              conversationId,
              wasMentioned: mentionDebug.wasMentioned,
              ...mentionDebug.details,
            },
            "group mention debug",
          );
          const wasMentioned = mentionDebug.wasMentioned;
          if (mentionConfig.requireMention && !wasMentioned) {
            logVerbose(
              `Group message stored for context (no mention detected) in ${conversationId}: ${msg.body}`,
            );
            return;
          }
        }

        return enqueueBatch(msg);
      },
    });

    // Surface a concise connection event for the next main-session turn/heartbeat.
    const { e164: selfE164 } = readWebSelfId();
    enqueueSystemEvent(
      `WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`,
    );

    setActiveWebListener(listener);

    const closeListener = async () => {
      setActiveWebListener(null);
      if (heartbeat) clearInterval(heartbeat);
      if (replyHeartbeatTimer) clearInterval(replyHeartbeatTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (backgroundTasks.size > 0) {
        await Promise.allSettled(backgroundTasks);
        backgroundTasks.clear();
      }
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    };

    if (keepAlive) {
      heartbeat = setInterval(() => {
        if (!heartbeatsEnabled) return;
        const authAgeMs = getWebAuthAgeMs();
        const minutesSinceLastMessage = lastMessageAt
          ? Math.floor((Date.now() - lastMessageAt) / 60000)
          : null;

        const logData = {
          connectionId,
          reconnectAttempts,
          messagesHandled: handledMessages,
          lastMessageAt,
          authAgeMs,
          uptimeMs: Date.now() - startedAt,
          ...(minutesSinceLastMessage !== null && minutesSinceLastMessage > 30
            ? { minutesSinceLastMessage }
            : {}),
        };

        // Warn if no messages in 30+ minutes
        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          heartbeatLogger.warn(
            logData,
            "⚠️ web gateway heartbeat - no messages in 30+ minutes",
          );
        } else {
          heartbeatLogger.info(logData, "web gateway heartbeat");
        }
      }, heartbeatSeconds * 1000);

      // Watchdog: Auto-restart if no messages received for MESSAGE_TIMEOUT_MS
      watchdogTimer = setInterval(() => {
        if (lastMessageAt) {
          const timeSinceLastMessage = Date.now() - lastMessageAt;
          if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
            const minutesSinceLastMessage = Math.floor(
              timeSinceLastMessage / 60000,
            );
            heartbeatLogger.warn(
              {
                connectionId,
                minutesSinceLastMessage,
                lastMessageAt: new Date(lastMessageAt),
                messagesHandled: handledMessages,
              },
              "Message timeout detected - forcing reconnect",
            );
            console.error(
              `⚠️  No messages received in ${minutesSinceLastMessage}m - restarting connection`,
            );
            closeListener(); // Trigger reconnect
          }
        }
      }, WATCHDOG_CHECK_MS);
    }

    const runReplyHeartbeat = async () => {
      if (!heartbeatsEnabled) return;
      const queued = getQueueSize();
      if (queued > 0) {
        heartbeatLogger.info(
          { connectionId, reason: "requests-in-flight", queued },
          "reply heartbeat skipped",
        );
        console.log(success("heartbeat: skipped (requests in flight)"));
        return;
      }
      if (!replyHeartbeatMinutes) return;
      if (lastInboundMsg?.chatType === "group") {
        heartbeatLogger.info(
          { connectionId, reason: "last-inbound-group" },
          "reply heartbeat skipped",
        );
        console.log(success("heartbeat: skipped (group chat)"));
        return;
      }
      const tickStart = Date.now();
      if (!lastInboundMsg) {
        const fallbackTo = getFallbackRecipient(cfg);
        if (!fallbackTo) {
          heartbeatLogger.info(
            {
              connectionId,
              reason: "no-recent-inbound",
              durationMs: Date.now() - tickStart,
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: skipped (no recent inbound)"));
          return;
        }
        const snapshot = getSessionSnapshot(cfg, fallbackTo, true);
        if (!snapshot.entry) {
          heartbeatLogger.info(
            { connectionId, to: fallbackTo, reason: "no-session-for-fallback" },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: skipped (no session to resume)"));
          return;
        }
        if (isVerbose()) {
          heartbeatLogger.info(
            {
              connectionId,
              to: fallbackTo,
              reason: "fallback-session",
              sessionId: snapshot.entry?.sessionId ?? null,
              sessionFresh: snapshot.fresh,
            },
            "reply heartbeat start",
          );
        }
        await runWebHeartbeatOnce({
          cfg,
          to: fallbackTo,
          verbose,
          replyResolver,
          runtime,
          sessionId: snapshot.entry.sessionId,
        });
        heartbeatLogger.info(
          {
            connectionId,
            to: fallbackTo,
            ...snapshot,
            durationMs: Date.now() - tickStart,
          },
          "reply heartbeat sent (fallback session)",
        );
        return;
      }

      try {
        const snapshot = getSessionSnapshot(cfg, lastInboundMsg.from);
        if (isVerbose()) {
          heartbeatLogger.info(
            {
              connectionId,
              to: lastInboundMsg.from,
              intervalMinutes: replyHeartbeatMinutes,
              sessionKey: snapshot.key,
              sessionId: snapshot.entry?.sessionId ?? null,
              sessionFresh: snapshot.fresh,
            },
            "reply heartbeat start",
          );
        }
        const replyResult = await (replyResolver ?? getReplyFromConfig)(
          {
            Body: HEARTBEAT_PROMPT,
            From: lastInboundMsg.from,
            To: lastInboundMsg.to,
            MessageSid: snapshot.entry?.sessionId,
            MediaPath: undefined,
            MediaUrl: undefined,
            MediaType: undefined,
          },
          {
            onReplyStart: lastInboundMsg.sendComposing,
            isHeartbeat: true,
          },
        );

        const replyPayload = Array.isArray(replyResult)
          ? replyResult[0]
          : replyResult;

        if (
          !replyPayload ||
          (!replyPayload.text &&
            !replyPayload.mediaUrl &&
            !replyPayload.mediaUrls?.length)
        ) {
          heartbeatLogger.info(
            {
              connectionId,
              durationMs: Date.now() - tickStart,
              reason: "empty-reply",
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: ok (empty reply)"));
          return;
        }

        const stripped = stripHeartbeatToken(replyPayload.text);
        const hasMedia = Boolean(
          replyPayload.mediaUrl || (replyPayload.mediaUrls?.length ?? 0) > 0,
        );
        if (stripped.shouldSkip && !hasMedia) {
          heartbeatLogger.info(
            {
              connectionId,
              durationMs: Date.now() - tickStart,
              reason: "heartbeat-token",
              rawLength: replyPayload.text?.length ?? 0,
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: ok (HEARTBEAT_OK)"));
          return;
        }

        // Apply response prefix if configured (same as regular messages)
        let finalText = stripped.text;
        const responsePrefix = cfg.inbound?.responsePrefix;
        if (
          responsePrefix &&
          finalText &&
          !finalText.startsWith(responsePrefix)
        ) {
          finalText = `${responsePrefix} ${finalText}`;
        }

        const cleanedReply: ReplyPayload = {
          ...replyPayload,
          text: finalText,
        };

        await deliverWebReply({
          replyResult: cleanedReply,
          msg: lastInboundMsg,
          maxMediaBytes,
          replyLogger,
          runtime,
          connectionId,
        });

        const durationMs = Date.now() - tickStart;
        const summary = `heartbeat: alert sent (${formatDuration(durationMs)})`;
        console.log(summary);
        heartbeatLogger.info(
          {
            connectionId,
            durationMs,
            hasMedia,
            chars: stripped.text?.length ?? 0,
          },
          "reply heartbeat sent",
        );
      } catch (err) {
        const durationMs = Date.now() - tickStart;
        heartbeatLogger.warn(
          {
            connectionId,
            error: String(err),
            durationMs,
          },
          "reply heartbeat failed",
        );
        console.log(
          danger(`heartbeat: failed (${formatDuration(durationMs)})`),
        );
      }
    };

    if (replyHeartbeatMinutes && !replyHeartbeatTimer) {
      const intervalMs = replyHeartbeatMinutes * 60_000;
      replyHeartbeatTimer = setInterval(() => {
        if (!heartbeatsEnabled) return;
        void runReplyHeartbeat();
      }, intervalMs);
      if (tuning.replyHeartbeatNow) {
        void runReplyHeartbeat();
      }
    }

    logInfo(
      "📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
      runtime,
    );

    if (!keepAlive) {
      await closeListener();
      return;
    }

    const reason = await Promise.race([
      listener.onClose?.catch((err) => {
        reconnectLogger.error(
          { error: String(err) },
          "listener.onClose rejected",
        );
        return { status: 500, isLoggedOut: false, error: err };
      }) ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > heartbeatSeconds * 1000) {
      reconnectAttempts = 0; // Healthy stretch; reset the backoff.
    }

    if (stopRequested() || sigintStop || reason === "aborted") {
      await closeListener();
      break;
    }

    const status =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? "unknown";
    const loggedOut =
      typeof reason === "object" &&
      reason &&
      "isLoggedOut" in reason &&
      (reason as { isLoggedOut?: boolean }).isLoggedOut;

    const errorStr = formatError(reason);

    reconnectLogger.info(
      {
        connectionId,
        status,
        loggedOut,
        reconnectAttempts,
        error: errorStr,
      },
      "web reconnect: connection closed",
    );

    enqueueSystemEvent(
      `WhatsApp gateway disconnected (status ${status ?? "unknown"})`,
    );

    if (loggedOut) {
      runtime.error(
        danger(
          "WhatsApp session logged out. Run `clawdis login --provider web` to relink.",
        ),
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    if (
      reconnectPolicy.maxAttempts > 0 &&
      reconnectAttempts >= reconnectPolicy.maxAttempts
    ) {
      reconnectLogger.warn(
        {
          connectionId,
          status,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts,
        },
        "web reconnect: max attempts reached; continuing in degraded mode",
      );
      runtime.error(
        danger(
          `WhatsApp Web reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`,
        ),
      );
      await closeListener();
      break;
    }

    const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
    reconnectLogger.info(
      {
        connectionId,
        status,
        reconnectAttempts,
        maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
        delayMs: delay,
      },
      "web reconnect: scheduling retry",
    );
    runtime.error(
      danger(
        `WhatsApp Web connection closed (status ${status}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDuration(delay)}… (${errorStr})`,
      ),
    );
    await closeListener();
    try {
      await sleep(delay, abortSignal);
    } catch {
      break;
    }
  }

  process.removeListener("SIGINT", handleSigint);
}

export { DEFAULT_WEB_MEDIA_BYTES };

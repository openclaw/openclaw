import { chunkText } from "../auto-reply/chunk.js";
import {
  HEARTBEAT_PROMPT,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { ClawdisConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging.js";
import { getQueueSize } from "../process/command-queue.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { normalizeE164 } from "../utils.js";
import { sendMessageWhatsApp } from "../web/outbound.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import {
  type HeartbeatRunResult,
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

export type HeartbeatTarget = "last" | "whatsapp" | "telegram" | "none";

export type HeartbeatDeliveryTarget = {
  channel: "whatsapp" | "telegram" | "none";
  to?: string;
  reason?: string;
};

type HeartbeatDeps = {
  runtime?: RuntimeEnv;
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  getQueueSize?: (lane?: string) => number;
  nowMs?: () => number;
};

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function resolveHeartbeatIntervalMs(
  cfg: ClawdisConfig,
  overrideEvery?: string,
) {
  const raw = overrideEvery ?? cfg.agent?.heartbeat?.every;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  let ms: number;
  try {
    ms = parseDurationMs(trimmed, { defaultUnit: "m" });
  } catch {
    return null;
  }
  if (ms <= 0) return null;
  return ms;
}

export function resolveHeartbeatPrompt(cfg: ClawdisConfig) {
  const raw = cfg.agent?.heartbeat?.prompt;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || HEARTBEAT_PROMPT;
}

function resolveHeartbeatSession(cfg: ClawdisConfig) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
  const sessionKey = scope === "global" ? "global" : mainKey;
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { sessionKey, storePath, store, entry };
}

function resolveHeartbeatSender(params: {
  allowFrom: Array<string | number>;
  lastTo?: string;
  lastChannel?: SessionEntry["lastChannel"];
}) {
  const { allowFrom, lastTo, lastChannel } = params;
  const candidates = [
    lastTo?.trim(),
    lastChannel === "telegram" && lastTo ? `telegram:${lastTo}` : undefined,
    lastChannel === "whatsapp" && lastTo ? `whatsapp:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = allowFrom
    .map((entry) => String(entry))
    .filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) =>
      allowList.includes(candidate),
    );
    if (matched) return matched;
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) return allowList[0];
  return candidates[0] ?? "heartbeat";
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: ClawdisConfig;
  entry?: SessionEntry;
}): HeartbeatDeliveryTarget {
  const { cfg, entry } = params;
  const rawTarget = cfg.agent?.heartbeat?.target;
  const target: HeartbeatTarget =
    rawTarget === "whatsapp" ||
    rawTarget === "telegram" ||
    rawTarget === "none" ||
    rawTarget === "last"
      ? rawTarget
      : "last";
  if (target === "none") {
    return { channel: "none", reason: "target-none" };
  }

  const explicitTo =
    typeof cfg.agent?.heartbeat?.to === "string" &&
    cfg.agent.heartbeat.to.trim()
      ? cfg.agent.heartbeat.to.trim()
      : undefined;

  const lastChannel =
    entry?.lastChannel && entry.lastChannel !== "webchat"
      ? entry.lastChannel
      : undefined;
  const lastTo = typeof entry?.lastTo === "string" ? entry.lastTo.trim() : "";

  const channel: "whatsapp" | "telegram" | undefined =
    target === "last"
      ? lastChannel
      : target === "whatsapp" || target === "telegram"
        ? target
        : undefined;

  const to =
    explicitTo ||
    (channel && lastChannel === channel ? lastTo : undefined) ||
    (target === "last" ? lastTo : undefined);

  if (!channel || !to) {
    return { channel: "none", reason: "no-target" };
  }

  if (channel !== "whatsapp") {
    return { channel, to };
  }

  const rawAllow = cfg.routing?.allowFrom ?? [];
  if (rawAllow.includes("*")) return { channel, to };
  const allowFrom = rawAllow
    .map((val) => normalizeE164(val))
    .filter((val) => val.length > 1);
  if (allowFrom.length === 0) return { channel, to };

  const normalized = normalizeE164(to);
  if (allowFrom.includes(normalized)) return { channel, to: normalized };
  return { channel, to: allowFrom[0], reason: "allowFrom-fallback" };
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") return;
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) return;
  if (entry.updatedAt === updatedAt) return;
  store[sessionKey] = { ...entry, updatedAt };
  await saveSessionStore(storePath, store);
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix?: string,
) {
  const stripped = stripHeartbeatToken(payload.text);
  const hasMedia = Boolean(
    payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0,
  );
  if (stripped.shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

async function deliverHeartbeatReply(params: {
  channel: "whatsapp" | "telegram";
  to: string;
  text: string;
  mediaUrls: string[];
  deps: Required<Pick<HeartbeatDeps, "sendWhatsApp" | "sendTelegram">>;
}) {
  const { channel, to, text, mediaUrls, deps } = params;
  if (channel === "whatsapp") {
    if (mediaUrls.length === 0) {
      for (const chunk of chunkText(text, 4000)) {
        await deps.sendWhatsApp(to, chunk, { verbose: false });
      }
      return;
    }
    let first = true;
    for (const url of mediaUrls) {
      const caption = first ? text : "";
      first = false;
      await deps.sendWhatsApp(to, caption, { verbose: false, mediaUrl: url });
    }
    return;
  }

  if (mediaUrls.length === 0) {
    for (const chunk of chunkText(text, 4000)) {
      await deps.sendTelegram(to, chunk, { verbose: false });
    }
    return;
  }
  let first = true;
  for (const url of mediaUrls) {
    const caption = first ? text : "";
    first = false;
    await deps.sendTelegram(to, caption, { verbose: false, mediaUrl: url });
  }
}

export async function runHeartbeatOnce(opts: {
  cfg?: ClawdisConfig;
  reason?: string;
  deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  if (!heartbeatsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!resolveHeartbeatIntervalMs(cfg)) {
    return { status: "skipped", reason: "disabled" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)("main");
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  const { entry, sessionKey, storePath } = resolveHeartbeatSession(cfg);
  const previousUpdatedAt = entry?.updatedAt;
  const allowFrom = cfg.routing?.allowFrom ?? [];
  const sender = resolveHeartbeatSender({
    allowFrom,
    lastTo: entry?.lastTo,
    lastChannel: entry?.lastChannel,
  });
  const prompt = resolveHeartbeatPrompt(cfg);
  const ctx = {
    Body: prompt,
    From: sender,
    To: sender,
    Surface: "heartbeat",
  };

  try {
    const replyResult = await getReplyFromConfig(
      ctx,
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
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-empty",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const normalized = normalizeHeartbeatReply(
      replyPayload,
      cfg.messages?.responsePrefix,
    );
    if (normalized.shouldSkip && !normalized.hasMedia) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-token",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const delivery = resolveHeartbeatDeliveryTarget({ cfg, entry });
    const mediaUrls =
      replyPayload.mediaUrls ??
      (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);

    if (delivery.channel === "none" || !delivery.to) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: delivery.reason ?? "no-target",
        preview: normalized.text?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const deps = {
      sendWhatsApp: opts.deps?.sendWhatsApp ?? sendMessageWhatsApp,
      sendTelegram: opts.deps?.sendTelegram ?? sendMessageTelegram,
    };
    await deliverHeartbeatReply({
      channel: delivery.channel,
      to: delivery.to,
      text: normalized.text,
      mediaUrls,
      deps,
    });

    emitHeartbeatEvent({
      status: "sent",
      to: delivery.to,
      preview: normalized.text?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
    });
    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: ClawdisConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const cfg = opts.cfg ?? loadConfig();
  const intervalMs = resolveHeartbeatIntervalMs(cfg);
  if (!intervalMs) {
    log.info("heartbeat: disabled", { enabled: false });
  }

  const runtime = opts.runtime ?? defaultRuntime;
  const run = async (params?: { reason?: string }) => {
    const res = await runHeartbeatOnce({
      cfg,
      reason: params?.reason,
      deps: { runtime },
    });
    return res;
  };

  setHeartbeatWakeHandler(async (params) => run({ reason: params.reason }));

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs) {
    timer = setInterval(() => {
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, intervalMs);
    timer.unref?.();
    log.info("heartbeat: started", { intervalMs });
  }

  const cleanup = () => {
    setHeartbeatWakeHandler(null);
    if (timer) clearInterval(timer);
    timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup };
}

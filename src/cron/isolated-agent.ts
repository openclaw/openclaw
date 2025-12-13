import crypto from "node:crypto";

import { chunkText } from "../auto-reply/chunk.js";
import { runCommandReply } from "../auto-reply/command-reply.js";
import {
  applyTemplate,
  type TemplateContext,
} from "../auto-reply/templating.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { normalizeE164 } from "../utils.js";
import type { CronJob } from "./types.js";

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

function assertCommandReplyConfig(cfg: ClawdisConfig) {
  const reply = cfg.inbound?.reply;
  if (!reply || reply.mode !== "command" || !reply.command?.length) {
    throw new Error(
      "Configure inbound.reply.mode=command with reply.command before using cron agent jobs.",
    );
  }
  return reply as NonNullable<
    NonNullable<ClawdisConfig["inbound"]>["reply"]
  > & {
    mode: "command";
    command: string[];
  };
}

function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) return undefined;
  const limit = 2000;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) return summary;
  }
  return undefined;
}

function resolveDeliveryTarget(
  cfg: ClawdisConfig,
  jobPayload: {
    channel?: "last" | "whatsapp" | "telegram";
    to?: string;
  },
) {
  const requestedChannel =
    typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo =
    typeof jobPayload.to === "string" && jobPayload.to.trim()
      ? jobPayload.to.trim()
      : undefined;

  const sessionCfg = cfg.inbound?.reply?.session;
  const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  const main = store[mainKey];
  const lastChannel =
    main?.lastChannel && main.lastChannel !== "webchat"
      ? main.lastChannel
      : undefined;
  const lastTo = typeof main?.lastTo === "string" ? main.lastTo.trim() : "";

  const channel = (() => {
    if (requestedChannel === "whatsapp" || requestedChannel === "telegram") {
      return requestedChannel;
    }
    return lastChannel ?? "whatsapp";
  })();

  const to = (() => {
    if (explicitTo) return explicitTo;
    return lastTo || undefined;
  })();

  const sanitizedWhatsappTo = (() => {
    if (channel !== "whatsapp") return to;
    const rawAllow = cfg.inbound?.allowFrom ?? [];
    if (rawAllow.includes("*")) return to;
    const allowFrom = rawAllow
      .map((val) => normalizeE164(val))
      .filter((val) => val.length > 1);
    if (allowFrom.length === 0) return to;
    if (!to) return allowFrom[0];
    const normalized = normalizeE164(to);
    if (allowFrom.includes(normalized)) return normalized;
    return allowFrom[0];
  })();

  return {
    channel,
    to: channel === "whatsapp" ? sanitizedWhatsappTo : to,
  };
}

function resolveCronSession(params: {
  cfg: ClawdisConfig;
  sessionKey: string;
  nowMs: number;
}) {
  const sessionCfg = params.cfg.inbound?.reply?.session;
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const fresh = entry && params.nowMs - entry.updatedAt <= idleMs;
  const sessionId = fresh ? entry.sessionId : crypto.randomUUID();
  const systemSent = fresh ? Boolean(entry.systemSent) : false;
  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    contextTokens: entry?.contextTokens,
    lastChannel: entry?.lastChannel,
    lastTo: entry?.lastTo,
    syncing: entry?.syncing,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession: !fresh };
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: ClawdisConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  sessionKey: string;
  lane?: string;
}): Promise<RunCronAgentTurnResult> {
  const replyCfg = assertCommandReplyConfig(params.cfg);
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    nowMs: now,
  });
  const sendSystemOnce = replyCfg.session?.sendSystemOnce === true;
  const isFirstTurnInSession =
    cronSession.isNewSession || !cronSession.systemSent;
  const sessionIntro = replyCfg.session?.sessionIntro
    ? applyTemplate(replyCfg.session.sessionIntro, {
        SessionId: cronSession.sessionEntry.sessionId,
      })
    : "";
  const bodyPrefix = replyCfg.bodyPrefix
    ? applyTemplate(replyCfg.bodyPrefix, {
        SessionId: cronSession.sessionEntry.sessionId,
      })
    : "";

  const thinkOverride = normalizeThinkLevel(replyCfg.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn"
      ? params.job.payload.thinking
      : undefined) ?? undefined,
  );
  const thinkLevel = jobThink ?? thinkOverride;

  const timeoutSecondsRaw =
    params.job.payload.kind === "agentTurn" && params.job.payload.timeoutSeconds
      ? params.job.payload.timeoutSeconds
      : (replyCfg.timeoutSeconds ?? 600);
  const timeoutSeconds = Math.max(Math.floor(timeoutSecondsRaw), 1);
  const timeoutMs = timeoutSeconds * 1000;

  const delivery =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.deliver === true;
  const bestEffortDeliver =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.bestEffortDeliver === true;

  const resolvedDelivery = resolveDeliveryTarget(params.cfg, {
    channel:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.channel
        : "last",
    to:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.to
        : undefined,
  });

  const base =
    `[cron:${params.job.id}${params.job.name ? ` ${params.job.name}` : ""}] ${params.message}`.trim();

  let commandBody = base;
  if (!sendSystemOnce || isFirstTurnInSession) {
    commandBody = bodyPrefix ? `${bodyPrefix}${commandBody}` : commandBody;
  }
  if (sessionIntro) {
    commandBody = `${sessionIntro}\n\n${commandBody}`;
  }

  const templatingCtx: TemplateContext = {
    Body: commandBody,
    BodyStripped: commandBody,
    SessionId: cronSession.sessionEntry.sessionId,
    From: resolvedDelivery.to ?? "",
    To: resolvedDelivery.to ?? "",
    Surface: "Cron",
    IsNewSession: cronSession.isNewSession ? "true" : "false",
  };

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  if (sendSystemOnce && isFirstTurnInSession) {
    cronSession.sessionEntry.systemSent = true;
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  } else {
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }

  const lane = params.lane?.trim() || "cron";

  let runResult: Awaited<ReturnType<typeof runCommandReply>>;
  try {
    runResult = await runCommandReply({
      reply: { ...replyCfg, mode: "command" },
      templatingCtx,
      sendSystemOnce,
      isNewSession: cronSession.isNewSession,
      isFirstTurnInSession,
      systemSent: cronSession.sessionEntry.systemSent ?? false,
      timeoutMs,
      timeoutSeconds,
      thinkLevel,
      enqueue: (task, opts) => enqueueCommandInLane(lane, task, opts),
      runId: cronSession.sessionEntry.sessionId,
    });
  } catch (err) {
    return { status: "error", error: String(err) };
  }

  const payloads = runResult.payloads ?? [];
  const firstText = payloads[0]?.text ?? "";
  const summary =
    pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);

  if (delivery) {
    if (resolvedDelivery.channel === "whatsapp") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to WhatsApp requires a recipient.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no WhatsApp recipient).",
        };
      }
      const to = normalizeE164(resolvedDelivery.to);
      try {
        for (const payload of payloads) {
          const mediaList =
            payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const primaryMedia = mediaList[0];
          await params.deps.sendMessageWhatsApp(to, payload.text ?? "", {
            verbose: false,
            mediaUrl: primaryMedia,
          });
          for (const extra of mediaList.slice(1)) {
            await params.deps.sendMessageWhatsApp(to, "", {
              verbose: false,
              mediaUrl: extra,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.channel === "telegram") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to Telegram requires a chatId.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no Telegram chatId).",
        };
      }
      const chatId = resolvedDelivery.to;
      try {
        for (const payload of payloads) {
          const mediaList =
            payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          if (mediaList.length === 0) {
            for (const chunk of chunkText(payload.text ?? "", 4000)) {
              await params.deps.sendMessageTelegram(chatId, chunk, {
                verbose: false,
              });
            }
          } else {
            let first = true;
            for (const url of mediaList) {
              const caption = first ? (payload.text ?? "") : "";
              first = false;
              await params.deps.sendMessageTelegram(chatId, caption, {
                verbose: false,
                mediaUrl: url,
              });
            }
          }
        }
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    }
  }

  return { status: "ok", summary };
}

import crypto from "node:crypto";

import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveBundledPiBinary } from "../agents/pi-path.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import { type ClawdisConfig, loadConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_RESET_TRIGGER,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { isVerbose, logVerbose } from "../globals.js";
import { buildProviderSummary } from "../infra/provider-summary.js";
import { triggerClawdisRestart } from "../infra/restart.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import { getWebAuthAgeMs, webAuthExists } from "../web/session.js";
import { runCommandReply } from "./command-reply.js";
import { buildStatusMessage } from "./status.js";
import {
  applyTemplate,
  type MsgContext,
  type TemplateContext,
} from "./templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "./thinking.js";
import { isAudio, transcribeInboundAudio } from "./transcription.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

export type { GetReplyOptions, ReplyPayload } from "./types.js";

const ABORT_TRIGGERS = new Set(["stop", "esc", "abort", "wait", "exit"]);
const ABORT_MEMORY = new Map<string, boolean>();
const SYSTEM_MARK = "⚙️";

type ReplyConfig = NonNullable<ClawdisConfig["inbound"]>["reply"];

type ResolvedReplyConfig = NonNullable<ReplyConfig>;

export function extractThinkDirective(body?: string): {
  cleaned: string;
  thinkLevel?: ThinkLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  // Match the longest keyword first to avoid partial captures (e.g. "/think:high")
  const match = body.match(
    /(?:^|\s)\/(?:thinking|think|t)\s*:?\s*([a-zA-Z-]+)\b/i,
  );
  const thinkLevel = normalizeThinkLevel(match?.[1]);
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    thinkLevel,
    rawLevel: match?.[1],
    hasDirective: !!match,
  };
}

export function extractVerboseDirective(body?: string): {
  cleaned: string;
  verboseLevel?: VerboseLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const match = body.match(
    /(?:^|\s)\/(?:verbose|v)(?=$|\s|:)\s*:?\s*([a-zA-Z-]+)\b/i,
  );
  const verboseLevel = normalizeVerboseLevel(match?.[1]);
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    verboseLevel,
    rawLevel: match?.[1],
    hasDirective: !!match,
  };
}

function isAbortTrigger(text?: string): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return ABORT_TRIGGERS.has(normalized);
}

function stripStructuralPrefixes(text: string): string {
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  const marker = "[Current message - respond to this]";
  const afterMarker = text.includes(marker)
    ? text.slice(text.indexOf(marker) + marker.length)
    : text;
  return afterMarker
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: ClawdisConfig | undefined,
): string {
  let result = text;
  const patterns = cfg?.inbound?.groupChat?.mentionPatterns ?? [];
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "gi");
      result = result.replace(re, " ");
    } catch {
      // ignore invalid regex
    }
  }
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (selfE164) {
    const esc = selfE164.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(esc, "gi"), " ")
      .replace(new RegExp(`@${esc}`, "gi"), " ");
  }
  // Generic mention patterns like @123456789 or plain digits
  result = result.replace(/@[0-9+]{5,}/g, " ");
  return result.replace(/\s+/g, " ").trim();
}

function makeDefaultPiReply(): ResolvedReplyConfig {
  const piBin = resolveBundledPiBinary() ?? "pi";
  const defaultContext =
    lookupContextTokens(DEFAULT_MODEL) ?? DEFAULT_CONTEXT_TOKENS;
  return {
    mode: "command" as const,
    command: [piBin, "--mode", "rpc", "{{BodyStripped}}"],
    agent: {
      kind: "pi" as const,
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      contextTokens: defaultContext,
      format: "json" as const,
    },
    session: {
      scope: "per-sender" as const,
      resetTriggers: [DEFAULT_RESET_TRIGGER],
      idleMinutes: DEFAULT_IDLE_MINUTES,
    },
    timeoutSeconds: 600,
  };
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: ClawdisConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  // Choose reply from config: static text or external command stdout.
  const cfg = configOverride ?? loadConfig();
  const workspaceDir = cfg.inbound?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const configuredReply = cfg.inbound?.reply as ResolvedReplyConfig | undefined;
  const reply: ResolvedReplyConfig = configuredReply
    ? { ...configuredReply, cwd: configuredReply.cwd ?? workspaceDir }
    : { ...makeDefaultPiReply(), cwd: workspaceDir };
  const identity = cfg.identity;
  if (identity?.name?.trim() && reply.session && !reply.session.sessionIntro) {
    const name = identity.name.trim();
    const theme = identity.theme?.trim();
    const emoji = identity.emoji?.trim();
    const introParts = [
      `You are ${name}.`,
      theme ? `Theme: ${theme}.` : undefined,
      emoji ? `Your emoji is ${emoji}.` : undefined,
    ].filter(Boolean);
    reply.session = { ...reply.session, sessionIntro: introParts.join(" ") };
  }

  // Bootstrap the workspace (and a starter AGENTS.md) only when we actually run from it.
  if (reply.mode === "command" && typeof reply.cwd === "string") {
    const resolvedWorkspace = resolveUserPath(workspaceDir);
    const resolvedCwd = resolveUserPath(reply.cwd);
    if (resolvedCwd === resolvedWorkspace) {
      await ensureAgentWorkspace({ dir: workspaceDir, ensureAgentsFile: true });
    }
  }
  const timeoutSeconds = Math.max(reply.timeoutSeconds ?? 600, 1);
  const timeoutMs = timeoutSeconds * 1000;
  let started = false;
  const triggerTyping = async () => {
    await opts?.onReplyStart?.();
  };
  const onReplyStart = async () => {
    if (started) return;
    started = true;
    await triggerTyping();
  };
  let typingTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs =
    reply?.mode === "command"
      ? (reply.typingIntervalSeconds ??
          reply?.session?.typingIntervalSeconds ??
          8) * 1000
      : 0;
  const cleanupTyping = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };
  const startTypingLoop = async () => {
    if (!opts?.onReplyStart) return;
    if (typingIntervalMs <= 0) return;
    if (typingTimer) return;
    await triggerTyping();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };
  let transcribedText: string | undefined;

  // Optional audio transcription before templating/session handling.
  if (cfg.inbound?.transcribeAudio && isAudio(ctx.MediaType)) {
    const transcribed = await transcribeInboundAudio(cfg, ctx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Body = transcribed.text;
      ctx.Transcript = transcribed.text;
      logVerbose("Replaced Body with audio transcript for reply flow");
    }
  }

  // Optional session handling (conversation reuse + /new resets)
  const sessionCfg = reply?.session;
  const mainKey = sessionCfg?.mainKey ?? "main";
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : [DEFAULT_RESET_TRIGGER];
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store);
  let sessionStore: ReturnType<typeof loadSessionStore> | undefined;
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry | undefined;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;

  const triggerBodyNormalized = stripStructuralPrefixes(ctx.Body ?? "")
    .trim()
    .toLowerCase();

  if (sessionCfg) {
    const rawBody = ctx.Body ?? "";
    const trimmedBody = rawBody.trim();
    // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
    // web inbox before we get here. They prevented reset triggers like "/new"
    // from matching, so strip structural wrappers when checking for resets.
    const strippedForReset = triggerBodyNormalized;
    for (const trigger of resetTriggers) {
      if (!trigger) continue;
      if (trimmedBody === trigger || strippedForReset === trigger) {
        isNewSession = true;
        bodyStripped = "";
        break;
      }
      const triggerPrefix = `${trigger} `;
      if (
        trimmedBody.startsWith(triggerPrefix) ||
        strippedForReset.startsWith(triggerPrefix)
      ) {
        isNewSession = true;
        bodyStripped = strippedForReset.slice(trigger.length).trimStart();
        break;
      }
    }

    sessionKey = resolveSessionKey(sessionScope, ctx, mainKey);
    sessionStore = loadSessionStore(storePath);
    const entry = sessionStore[sessionKey];
    const idleMs = idleMinutes * 60_000;
    const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

    if (!isNewSession && freshEntry) {
      sessionId = entry.sessionId;
      systemSent = entry.systemSent ?? false;
      abortedLastRun = entry.abortedLastRun ?? false;
      persistedThinking = entry.thinkingLevel;
      persistedVerbose = entry.verboseLevel;
    } else {
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
      abortedLastRun = false;
    }

    const baseEntry = !isNewSession && freshEntry ? entry : undefined;
    sessionEntry = {
      ...baseEntry,
      sessionId,
      updatedAt: Date.now(),
      systemSent,
      abortedLastRun,
      // Persist previously stored thinking/verbose levels when present.
      thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
      verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    };
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const sessionCtx: TemplateContext = {
    ...ctx,
    BodyStripped: bodyStripped ?? ctx.Body,
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  const {
    cleaned: thinkCleaned,
    thinkLevel: inlineThink,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = extractThinkDirective(sessionCtx.BodyStripped ?? sessionCtx.Body ?? "");
  const {
    cleaned: verboseCleaned,
    verboseLevel: inlineVerbose,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = extractVerboseDirective(thinkCleaned);
  sessionCtx.Body = verboseCleaned;
  sessionCtx.BodyStripped = verboseCleaned;

  const isGroup =
    typeof ctx.From === "string" &&
    (ctx.From.includes("@g.us") || ctx.From.startsWith("group:"));

  let resolvedThinkLevel =
    inlineThink ??
    (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (reply?.thinkingDefault as ThinkLevel | undefined);

  const resolvedVerboseLevel =
    inlineVerbose ??
    (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (reply?.verboseDefault as VerboseLevel | undefined);

  const combinedDirectiveOnly =
    hasThinkDirective &&
    hasVerboseDirective &&
    (() => {
      const stripped = stripStructuralPrefixes(verboseCleaned ?? "");
      const noMentions = isGroup ? stripMentions(stripped, ctx, cfg) : stripped;
      return noMentions.length === 0;
    })();

  const directiveOnly = (() => {
    if (!hasThinkDirective) return false;
    if (!thinkCleaned) return true;
    // Check after stripping both think and verbose so combined directives count.
    const stripped = stripStructuralPrefixes(verboseCleaned);
    const noMentions = isGroup ? stripMentions(stripped, ctx, cfg) : stripped;
    return noMentions.length === 0;
  })();

  // Directive-only message => persist session thinking level and return ack
  if (directiveOnly || combinedDirectiveOnly) {
    if (!inlineThink) {
      cleanupTyping();
      return {
        text: `Unrecognized thinking level "${rawThinkLevel ?? ""}". Valid levels: off, minimal, low, medium, high.`,
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      if (inlineThink === "off") {
        delete sessionEntry.thinkingLevel;
      } else {
        sessionEntry.thinkingLevel = inlineThink;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
    // If verbose directive is also present, persist it too.
    if (
      hasVerboseDirective &&
      inlineVerbose &&
      sessionEntry &&
      sessionStore &&
      sessionKey
    ) {
      if (inlineVerbose === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = inlineVerbose;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
    const parts: string[] = [];
    if (inlineThink === "off") {
      parts.push("Thinking disabled.");
    } else {
      parts.push(`Thinking level set to ${inlineThink}.`);
    }
    if (hasVerboseDirective) {
      if (!inlineVerbose) {
        parts.push(
          `Unrecognized verbose level "${rawVerboseLevel ?? ""}". Valid levels: off, on.`,
        );
      } else {
        parts.push(
          inlineVerbose === "off"
            ? "Verbose logging disabled."
            : "Verbose logging enabled.",
        );
      }
    }
    const ack = parts.join(" ");
    cleanupTyping();
    return { text: ack };
  }

  const verboseDirectiveOnly = (() => {
    if (!hasVerboseDirective) return false;
    if (!verboseCleaned) return true;
    const stripped = stripStructuralPrefixes(verboseCleaned);
    const noMentions = isGroup ? stripMentions(stripped, ctx, cfg) : stripped;
    return noMentions.length === 0;
  })();

  if (verboseDirectiveOnly) {
    if (!inlineVerbose) {
      cleanupTyping();
      return {
        text: `Unrecognized verbose level "${rawVerboseLevel ?? ""}". Valid levels: off, on.`,
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      if (inlineVerbose === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = inlineVerbose;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
    const ack =
      inlineVerbose === "off"
        ? `${SYSTEM_MARK} Verbose logging disabled.`
        : `${SYSTEM_MARK} Verbose logging enabled.`;
    cleanupTyping();
    return { text: ack };
  }

  // Persist inline think/verbose settings even when additional content follows.
  if (sessionEntry && sessionStore && sessionKey) {
    let updated = false;
    if (hasThinkDirective && inlineThink) {
      if (inlineThink === "off") {
        delete sessionEntry.thinkingLevel;
      } else {
        sessionEntry.thinkingLevel = inlineThink;
      }
      updated = true;
    }
    if (hasVerboseDirective && inlineVerbose) {
      if (inlineVerbose === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = inlineVerbose;
      }
      updated = true;
    }
    if (updated) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
  }

  // Optional allowlist by origin number (E.164 without whatsapp: prefix)
  const configuredAllowFrom = cfg.inbound?.allowFrom;
  const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
  const to = (ctx.To ?? "").replace(/^whatsapp:/, "");
  const isSamePhone = from && to && from === to;
  // If no config is present, default to self-only DM access.
  const defaultAllowFrom =
    (!configuredAllowFrom || configuredAllowFrom.length === 0) && to
      ? [to]
      : undefined;
  const allowFrom =
    configuredAllowFrom && configuredAllowFrom.length > 0
      ? configuredAllowFrom
      : defaultAllowFrom;
  const abortKey = sessionKey ?? (from || undefined) ?? (to || undefined);
  const rawBodyNormalized = triggerBodyNormalized;

  if (!sessionEntry && abortKey) {
    abortedLastRun = ABORT_MEMORY.get(abortKey) ?? false;
  }

  // Same-phone mode (self-messaging) is always allowed
  if (isSamePhone) {
    logVerbose(`Allowing same-phone mode: from === to (${from})`);
  } else if (!isGroup && Array.isArray(allowFrom) && allowFrom.length > 0) {
    // Support "*" as wildcard to allow all senders
    if (!allowFrom.includes("*") && !allowFrom.includes(from)) {
      logVerbose(
        `Skipping auto-reply: sender ${from || "<unknown>"} not in allowFrom list`,
      );
      cleanupTyping();
      return undefined;
    }
  }

  if (
    rawBodyNormalized === "/restart" ||
    rawBodyNormalized === "restart" ||
    rawBodyNormalized.startsWith("/restart ")
  ) {
    triggerClawdisRestart();
    cleanupTyping();
    return {
      text: "⚙️ Restarting clawdis via launchctl; give me a few seconds to come back online.",
    };
  }

  if (
    rawBodyNormalized === "/status" ||
    rawBodyNormalized === "status" ||
    rawBodyNormalized.startsWith("/status ")
  ) {
    const webLinked = await webAuthExists();
    const webAuthAgeMs = getWebAuthAgeMs();
    const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
    const statusText = buildStatusMessage({
      reply,
      sessionEntry,
      sessionKey,
      sessionScope,
      storePath,
      resolvedThink: resolvedThinkLevel,
      resolvedVerbose: resolvedVerboseLevel,
      webLinked,
      webAuthAgeMs,
      heartbeatSeconds,
    });
    cleanupTyping();
    return { text: statusText };
  }

  const abortRequested =
    reply?.mode === "command" && isAbortTrigger(rawBodyNormalized);

  if (abortRequested) {
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.abortedLastRun = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    } else if (abortKey) {
      ABORT_MEMORY.set(abortKey, true);
    }
    cleanupTyping();
    return { text: "⚙️ Agent was aborted." };
  }

  await startTypingLoop();

  // Optional prefix injected before Body for templating/command prompts.
  const sendSystemOnce = sessionCfg?.sendSystemOnce === true;
  const isFirstTurnInSession = isNewSession || !systemSent;
  const sessionIntro =
    isFirstTurnInSession && sessionCfg?.sessionIntro
      ? applyTemplate(sessionCfg.sessionIntro ?? "", sessionCtx)
      : "";
  const groupIntro =
    isFirstTurnInSession && sessionCtx.ChatType === "group"
      ? (() => {
          const subject = sessionCtx.GroupSubject?.trim();
          const members = sessionCtx.GroupMembers?.trim();
          const subjectLine = subject
            ? `You are replying inside the WhatsApp group "${subject}".`
            : "You are replying inside a WhatsApp group chat.";
          const membersLine = members
            ? `Group members: ${members}.`
            : undefined;
          return [subjectLine, membersLine]
            .filter(Boolean)
            .join(" ")
            .concat(
              " Address the specific sender noted in the message context.",
            );
        })()
      : "";
  const bodyPrefix = reply?.bodyPrefix
    ? applyTemplate(reply.bodyPrefix ?? "", sessionCtx)
    : "";
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const baseBodyTrimmed = baseBody.trim();
  const rawBodyTrimmed = (ctx.Body ?? "").trim();
  const isBareSessionReset =
    isNewSession && baseBodyTrimmed.length === 0 && rawBodyTrimmed.length > 0;
  // Bail early if the cleaned body is empty to avoid sending blank prompts to the agent.
  // This can happen if an inbound platform delivers an empty text message or we strip everything out.
  if (!baseBodyTrimmed) {
    await onReplyStart();
    if (isBareSessionReset) {
      cleanupTyping();
      return {
        text: "Started a fresh session. Send a new message to continue.",
      };
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    cleanupTyping();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  const abortedHint =
    reply?.mode === "command" && abortedLastRun
      ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
      : "";
  let prefixedBodyBase = baseBody;
  if (!sendSystemOnce || isFirstTurnInSession) {
    prefixedBodyBase = bodyPrefix
      ? `${bodyPrefix}${prefixedBodyBase}`
      : prefixedBodyBase;
  }
  if (sessionIntro) {
    prefixedBodyBase = `${sessionIntro}\n\n${prefixedBodyBase}`;
  }
  if (groupIntro) {
    prefixedBodyBase = `${groupIntro}\n\n${prefixedBodyBase}`;
  }
  if (abortedHint) {
    prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.abortedLastRun = false;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    } else if (abortKey) {
      ABORT_MEMORY.set(abortKey, false);
    }
  }

  // Prepend queued system events and (for new main sessions) a provider snapshot.
  const isGroupSession =
    typeof ctx.From === "string" &&
    (ctx.From.includes("@g.us") || ctx.From.startsWith("group:"));
  const isMainSession =
    !isGroupSession && sessionKey === (sessionCfg?.mainKey ?? "main");
  if (isMainSession) {
    const systemLines: string[] = [];
    const queued = drainSystemEvents();
    systemLines.push(...queued);
    if (isNewSession) {
      const summary = await buildProviderSummary(cfg);
      if (summary.length > 0) systemLines.unshift(...summary);
    }
    if (systemLines.length > 0) {
      const block = systemLines.map((l) => `System: ${l}`).join("\n");
      prefixedBodyBase = `${block}\n\n${prefixedBodyBase}`;
    }
  }
  if (
    sessionCfg &&
    sendSystemOnce &&
    isFirstTurnInSession &&
    sessionStore &&
    sessionKey
  ) {
    const current = sessionEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    sessionEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
    };
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
    systemSent = true;
  }

  const prefixedBody =
    transcribedText && reply?.mode === "command"
      ? [prefixedBodyBase, `Transcript:\n${transcribedText}`]
          .filter(Boolean)
          .join("\n\n")
      : prefixedBodyBase;
  const mediaNote = ctx.MediaPath?.length
    ? `[media attached: ${ctx.MediaPath}${ctx.MediaType ? ` (${ctx.MediaType})` : ""}${ctx.MediaUrl ? ` | ${ctx.MediaUrl}` : ""}]`
    : undefined;
  // For command prompts we prepend the media note so Pi sees it; text replies stay clean.
  const mediaReplyHint =
    mediaNote && reply?.mode === "command"
      ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
      : undefined;
  let commandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim()
    : prefixedBody;

  // Fallback: if a stray leading level token remains, consume it
  if (!resolvedThinkLevel && commandBody) {
    const parts = commandBody.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel) {
      resolvedThinkLevel = maybeLevel;
      commandBody = parts.slice(1).join(" ").trim();
    }
  }
  const templatingCtx: TemplateContext = {
    ...sessionCtx,
    Body: commandBody,
    BodyStripped: commandBody,
  };
  if (!reply) {
    logVerbose("No inbound.reply configured; skipping auto-reply");
    cleanupTyping();
    return undefined;
  }

  if (reply.mode === "text" && reply.text) {
    await onReplyStart();
    logVerbose("Using text auto-reply from config");
    const result = {
      text: applyTemplate(reply.text ?? "", templatingCtx),
      mediaUrl: reply.mediaUrl,
    };
    cleanupTyping();
    return result;
  }

  const isHeartbeat = opts?.isHeartbeat === true;

  if (reply && reply.mode === "command") {
    const heartbeatCommand = isHeartbeat
      ? (reply as { heartbeatCommand?: string[] }).heartbeatCommand
      : undefined;
    const commandArgs = heartbeatCommand?.length
      ? heartbeatCommand
      : reply.command;

    if (!commandArgs?.length) {
      cleanupTyping();
      return undefined;
    }

    await onReplyStart();
    const commandReply = {
      ...reply,
      command: commandArgs,
      mode: "command" as const,
    };
    try {
      const runResult = await runCommandReply({
        reply: commandReply,
        templatingCtx,
        sendSystemOnce,
        isNewSession,
        isFirstTurnInSession,
        systemSent,
        timeoutMs,
        timeoutSeconds,
        thinkLevel: resolvedThinkLevel,
        verboseLevel: resolvedVerboseLevel,
        onPartialReply: opts?.onPartialReply,
      });
      const payloadArray = runResult.payloads ?? [];
      const meta = runResult.meta;
      let finalPayloads = payloadArray;
      if (!finalPayloads || finalPayloads.length === 0) {
        return undefined;
      }
      if (sessionCfg && sessionStore && sessionKey) {
        const returnedSessionId = meta.agentMeta?.sessionId;
        // TODO: remove once pi-mono persists stable session ids for custom --session paths.
        const allowMetaSessionId = false;
        if (
          allowMetaSessionId &&
          returnedSessionId &&
          returnedSessionId !== sessionId
        ) {
          const entry = sessionEntry ??
            sessionStore[sessionKey] ?? {
              sessionId: returnedSessionId,
              updatedAt: Date.now(),
              systemSent,
              abortedLastRun,
            };
          sessionEntry = {
            ...entry,
            sessionId: returnedSessionId,
            updatedAt: Date.now(),
          };
          sessionStore[sessionKey] = sessionEntry;
          await saveSessionStore(storePath, sessionStore);
          sessionId = returnedSessionId;
          if (isVerbose()) {
            logVerbose(
              `Session id updated from agent meta: ${returnedSessionId} (store: ${storePath})`,
            );
          }
        }

        const usage = meta.agentMeta?.usage;
        const model =
          meta.agentMeta?.model ||
          reply?.agent?.model ||
          sessionEntry?.model ||
          DEFAULT_MODEL;
        const contextTokens =
          reply?.agent?.contextTokens ??
          lookupContextTokens(model) ??
          sessionEntry?.contextTokens ??
          DEFAULT_CONTEXT_TOKENS;

        if (usage) {
          const entry = sessionEntry ?? sessionStore[sessionKey];
          if (entry) {
            const input = usage.input ?? 0;
            const output = usage.output ?? 0;
            const promptTokens =
              input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
            sessionEntry = {
              ...entry,
              inputTokens: input,
              outputTokens: output,
              // Track the effective prompt/context size (cached + uncached input).
              totalTokens:
                promptTokens > 0 ? promptTokens : (usage.total ?? input),
              model,
              contextTokens: contextTokens ?? entry.contextTokens,
              updatedAt: Date.now(),
            };
            sessionStore[sessionKey] = sessionEntry;
            await saveSessionStore(storePath, sessionStore);
          }
        } else if (model || contextTokens) {
          const entry = sessionEntry ?? sessionStore[sessionKey];
          if (entry) {
            sessionEntry = {
              ...entry,
              model: model ?? entry.model,
              contextTokens: contextTokens ?? entry.contextTokens,
            };
            sessionStore[sessionKey] = sessionEntry;
            await saveSessionStore(storePath, sessionStore);
          }
        }
      }
      if (meta.agentMeta && isVerbose()) {
        logVerbose(`Agent meta: ${JSON.stringify(meta.agentMeta)}`);
      }
      // If verbose is enabled and this is a new session, prepend a session hint.
      const sessionIdHint =
        resolvedVerboseLevel === "on" && isNewSession
          ? (sessionId ??
            meta.agentMeta?.sessionId ??
            templatingCtx.SessionId ??
            "unknown")
          : undefined;
      if (sessionIdHint) {
        finalPayloads = [
          { text: `🧭 New session: ${sessionIdHint}` },
          ...payloadArray,
        ];
      }
      return finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads;
    } finally {
      cleanupTyping();
    }
  }

  cleanupTyping();
  return undefined;
}

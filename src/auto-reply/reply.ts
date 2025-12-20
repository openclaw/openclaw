import crypto from "node:crypto";

import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
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
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { buildProviderSummary } from "../infra/provider-summary.js";
import { triggerClawdisRestart } from "../infra/restart.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import { getWebAuthAgeMs, webAuthExists } from "../web/session.js";
import { buildStatusMessage } from "./status.js";
import type { MsgContext, TemplateContext } from "./templating.js";
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

const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new. Say hi briefly and ask what the user wants to do next.";

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

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: ClawdisConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const cfg = configOverride ?? loadConfig();
  const workspaceDirRaw = cfg.inbound?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const agentCfg = cfg.inbound?.agent;
  const sessionCfg = cfg.inbound?.session;

  const provider = agentCfg?.provider?.trim() || DEFAULT_PROVIDER;
  const model = agentCfg?.model?.trim() || DEFAULT_MODEL;
  const contextTokens =
    agentCfg?.contextTokens ??
    lookupContextTokens(model) ??
    DEFAULT_CONTEXT_TOKENS;

  // Bootstrap the workspace and the required files (AGENTS.md, SOUL.md, TOOLS.md).
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: true,
  });
  const workspaceDir = workspace.dir;

  const timeoutSeconds = Math.max(agentCfg?.timeoutSeconds ?? 600, 1);
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
    (agentCfg?.typingIntervalSeconds ??
      sessionCfg?.typingIntervalSeconds ??
      8) * 1000;
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
    (agentCfg?.thinkingDefault as ThinkLevel | undefined);

  const resolvedVerboseLevel =
    inlineVerbose ??
    (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);

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
      agent: {
        provider,
        model,
        contextTokens,
        thinkingDefault: agentCfg?.thinkingDefault,
        verboseDefault: agentCfg?.verboseDefault,
      },
      workspaceDir,
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

  const abortRequested = isAbortTrigger(rawBodyNormalized);

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

  const isFirstTurnInSession = isNewSession || !systemSent;
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
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const rawBodyTrimmed = (ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const isBareSessionReset =
    isNewSession &&
    baseBodyTrimmedRaw.length === 0 &&
    rawBodyTrimmed.length > 0;
  const baseBodyFinal = isBareSessionReset ? BARE_SESSION_RESET_PROMPT : baseBody;
  const baseBodyTrimmed = baseBodyFinal.trim();
  // Bail early if the cleaned body is empty to avoid sending blank prompts to the agent.
  // This can happen if an inbound platform delivers an empty text message or we strip everything out.
  if (!baseBodyTrimmed) {
    await onReplyStart();
    logVerbose("Inbound body empty after normalization; skipping agent run");
    cleanupTyping();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  const abortedHint = abortedLastRun
    ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
    : "";
  let prefixedBodyBase = baseBodyFinal;
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

  // Prepend queued system events (transitions only) and (for new main sessions) a provider snapshot.
  // Token efficiency: we filter out periodic/heartbeat noise and keep the lines compact.
  const isGroupSession =
    typeof ctx.From === "string" &&
    (ctx.From.includes("@g.us") || ctx.From.startsWith("group:"));
  const isMainSession =
    !isGroupSession && sessionKey === (sessionCfg?.mainKey ?? "main");
  if (isMainSession) {
    const compactSystemEvent = (line: string): string | null => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const lower = trimmed.toLowerCase();
      if (lower.includes("reason periodic")) return null;
      if (lower.includes("heartbeat")) return null;
      if (trimmed.startsWith("Node:")) {
        // Drop the chatty "last input … ago" segment; keep connect/disconnect/launch reasons.
        return trimmed.replace(/ · last input [^·]+/i, "").trim();
      }
      return trimmed;
    };

    const systemLines: string[] = [];
    const queued = drainSystemEvents();
    systemLines.push(
      ...queued.map(compactSystemEvent).filter((v): v is string => Boolean(v)),
    );
    if (isNewSession) {
      const summary = await buildProviderSummary(cfg);
      if (summary.length > 0) systemLines.unshift(...summary);
    }
    if (systemLines.length > 0) {
      const block = systemLines.map((l) => `System: ${l}`).join("\n");
      prefixedBodyBase = `${block}\n\n${prefixedBodyBase}`;
    }
  }
  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = sessionEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      isFirstTurnInSession || !current.skillsSnapshot
        ? buildWorkspaceSkillSnapshot(workspaceDir, { config: cfg })
        : current.skillsSnapshot;
    sessionEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
    systemSent = true;
  }

  const skillsSnapshot =
    sessionEntry?.skillsSnapshot ??
    (isFirstTurnInSession
      ? undefined
      : buildWorkspaceSkillSnapshot(workspaceDir, { config: cfg }));
  if (
    skillsSnapshot &&
    sessionStore &&
    sessionKey &&
    !isFirstTurnInSession &&
    !sessionEntry?.skillsSnapshot
  ) {
    const current = sessionEntry ?? {
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    sessionEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const prefixedBody = transcribedText
    ? [prefixedBodyBase, `Transcript:\n${transcribedText}`]
        .filter(Boolean)
        .join("\n\n")
    : prefixedBodyBase;
  const mediaNote = ctx.MediaPath?.length
    ? `[media attached: ${ctx.MediaPath}${ctx.MediaType ? ` (${ctx.MediaType})` : ""}${ctx.MediaUrl ? ` | ${ctx.MediaUrl}` : ""}]`
    : undefined;
  const mediaReplyHint = mediaNote
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

  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionTranscriptPath(sessionIdFinal);

  await onReplyStart();

  try {
    const runId = crypto.randomUUID();
    const runResult = await runEmbeddedPiAgent({
      sessionId: sessionIdFinal,
      sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      prompt: commandBody,
      provider,
      model,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      timeoutMs,
      runId,
      onPartialReply: opts?.onPartialReply
        ? (payload) =>
            opts.onPartialReply?.({
              text: payload.text,
              mediaUrls: payload.mediaUrls,
            })
        : undefined,
    });

    const payloadArray = runResult.payloads ?? [];
    if (payloadArray.length === 0) return undefined;

    if (sessionStore && sessionKey) {
      const usage = runResult.meta.agentMeta?.usage;
      const modelUsed =
        runResult.meta.agentMeta?.model ?? agentCfg?.model ?? DEFAULT_MODEL;
      const contextTokensUsed =
        agentCfg?.contextTokens ??
        lookupContextTokens(modelUsed) ??
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
            totalTokens:
              promptTokens > 0 ? promptTokens : (usage.total ?? input),
            model: modelUsed,
            contextTokens: contextTokensUsed ?? entry.contextTokens,
            updatedAt: Date.now(),
          };
          sessionStore[sessionKey] = sessionEntry;
          await saveSessionStore(storePath, sessionStore);
        }
      } else if (modelUsed || contextTokensUsed) {
        const entry = sessionEntry ?? sessionStore[sessionKey];
        if (entry) {
          sessionEntry = {
            ...entry,
            model: modelUsed ?? entry.model,
            contextTokens: contextTokensUsed ?? entry.contextTokens,
          };
          sessionStore[sessionKey] = sessionEntry;
          await saveSessionStore(storePath, sessionStore);
        }
      }
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = payloadArray;
    if (resolvedVerboseLevel === "on" && isNewSession) {
      finalPayloads = [
        { text: `🧭 New session: ${sessionIdFinal}` },
        ...payloadArray,
      ];
    }

    return finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads;
  } finally {
    cleanupTyping();
  }
}

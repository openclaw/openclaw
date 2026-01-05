import type { ClawdbotConfig } from "../../config/config.js";
import {
  type SessionEntry,
  type SessionScope,
  saveSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { triggerClawdbotRestart } from "../../infra/restart.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeE164 } from "../../utils.js";
import { resolveHeartbeatSeconds } from "../../web/reconnect.js";
import { getWebAuthAgeMs, webAuthExists } from "../../web/session.js";
import {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import { buildStatusMessage } from "../status.js";
import type { MsgContext } from "../templating.js";
import type { ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { isAbortTrigger, setAbortMemory } from "./abort.js";
import type { InlineDirectives } from "./directive-handling.js";
import { stripMentions } from "./mentions.js";

export type CommandContext = {
  surface: string;
  isWhatsAppSurface: boolean;
  ownerList: string[];
  isAuthorizedSender: boolean;
  senderE164?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
};

export function buildCommandContext(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const {
    ctx,
    cfg,
    sessionKey,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
  } = params;
  const surface = (ctx.Surface ?? "").trim().toLowerCase();
  const isWhatsAppSurface =
    surface === "whatsapp" ||
    (ctx.From ?? "").startsWith("whatsapp:") ||
    (ctx.To ?? "").startsWith("whatsapp:");

  const configuredAllowFrom = isWhatsAppSurface
    ? cfg.whatsapp?.allowFrom
    : undefined;
  const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
  const to = (ctx.To ?? "").replace(/^whatsapp:/, "");
  const defaultAllowFrom =
    isWhatsAppSurface &&
    (!configuredAllowFrom || configuredAllowFrom.length === 0) &&
    to
      ? [to]
      : undefined;
  const allowFrom =
    configuredAllowFrom && configuredAllowFrom.length > 0
      ? configuredAllowFrom
      : defaultAllowFrom;

  const abortKey = sessionKey ?? (from || undefined) ?? (to || undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = isGroup
    ? stripMentions(rawBodyNormalized, ctx, cfg)
    : rawBodyNormalized;
  const senderE164 = normalizeE164(ctx.SenderE164 ?? "");
  const ownerCandidates = isWhatsAppSurface
    ? (allowFrom ?? []).filter((entry) => entry && entry !== "*")
    : [];
  if (isWhatsAppSurface && ownerCandidates.length === 0 && to) {
    ownerCandidates.push(to);
  }
  const ownerList = ownerCandidates
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
  const isOwner =
    !isWhatsAppSurface ||
    ownerList.length === 0 ||
    (senderE164 ? ownerList.includes(senderE164) : false);
  const isAuthorizedSender = commandAuthorized && isOwner;

  return {
    surface,
    isWhatsAppSurface,
    ownerList,
    isAuthorizedSender,
    senderE164: senderE164 || undefined,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from: from || undefined,
    to: to || undefined,
  };
}

export async function handleCommands(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  command: CommandContext;
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
}): Promise<{
  reply?: ReplyPayload;
  shouldContinue: boolean;
}> {
  const {
    cfg,
    command,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolveDefaultThinkingLevel,
    model,
    contextTokens,
    isGroup,
  } = params;

  const activationCommand = parseActivationCommand(
    command.commandBodyNormalized,
  );
  const sendPolicyCommand = parseSendPolicyCommand(
    command.commandBodyNormalized,
  );

  if (activationCommand.hasCommand) {
    if (!isGroup) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Group activation only applies to group chats." },
      };
    }
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /activation from unauthorized sender in group: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!activationCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /activation mention|always" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.groupActivation = activationCommand.mode;
      sessionEntry.groupActivationNeedsSystemIntro = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Group activation set to ${activationCommand.mode}.` },
    };
  }

  if (sendPolicyCommand.hasCommand) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /send from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!sendPolicyCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /send on|off|inherit" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      if (sendPolicyCommand.mode === "inherit") {
        delete sessionEntry.sendPolicy;
      } else {
        sessionEntry.sendPolicy = sendPolicyCommand.mode;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    const label =
      sendPolicyCommand.mode === "inherit"
        ? "inherit"
        : sendPolicyCommand.mode === "allow"
          ? "on"
          : "off";
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Send policy set to ${label}.` },
    };
  }

  if (
    command.commandBodyNormalized === "/restart" ||
    command.commandBodyNormalized === "restart" ||
    command.commandBodyNormalized.startsWith("/restart ")
  ) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /restart from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const restartMethod = triggerClawdbotRestart();
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Restarting clawdbot via ${restartMethod}; give me a few seconds to come back online.`,
      },
    };
  }

  const statusRequested =
    directives.hasStatusDirective ||
    command.commandBodyNormalized === "/status" ||
    command.commandBodyNormalized === "status" ||
    command.commandBodyNormalized.startsWith("/status ");
  if (statusRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /status from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const webLinked = await webAuthExists();
    const webAuthAgeMs = getWebAuthAgeMs();
    const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
    const groupActivation = isGroup
      ? (normalizeGroupActivation(sessionEntry?.groupActivation) ??
        defaultGroupActivation())
      : undefined;
    const statusText = buildStatusMessage({
      agent: {
        model,
        contextTokens,
        thinkingDefault: cfg.agent?.thinkingDefault,
        verboseDefault: cfg.agent?.verboseDefault,
      },
      workspaceDir,
      sessionEntry,
      sessionKey,
      sessionScope,
      storePath,
      groupActivation,
      resolvedThink:
        resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
      resolvedVerbose: resolvedVerboseLevel,
      webLinked,
      webAuthAgeMs,
      heartbeatSeconds,
    });
    return { shouldContinue: false, reply: { text: statusText } };
  }

  const abortRequested = isAbortTrigger(command.rawBodyNormalized);
  if (abortRequested) {
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.abortedLastRun = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    } else if (command.abortKey) {
      setAbortMemory(command.abortKey, true);
    }
    return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
  }

  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionEntry,
    sessionKey,
    surface: sessionEntry?.surface ?? command.surface,
    chatType: sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}

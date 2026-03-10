import { resolveUserTimezone } from "../../agents/date-time.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const DEFAULT_SAVE_PROMPT =
  "Review this conversation and save any important context, decisions, and insights to memory. Update memory/YYYY-MM-DD.md with a log of what happened today. Update MEMORY.md with anything worth keeping long-term. Be concise — capture what matters, skip the noise.";

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function extractSaveInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: import("../../config/config.js").OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/save") ? "/save" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

export const handleSaveCommand: CommandHandler = async (params) => {
  const normalized = params.command.commandBodyNormalized;
  const saveRequested =
    normalized === "/save" || normalized.startsWith("/save ") || normalized.startsWith("/save:");
  if (!saveRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /save from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const customInstructions = extractSaveInstructions({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    isGroup: params.isGroup,
  });
  const timezone = resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone);
  const dateStamp = formatDateStampInTimezone(Date.now(), timezone);
  const basePrompt = DEFAULT_SAVE_PROMPT.replaceAll("YYYY-MM-DD", dateStamp);
  const prompt = customInstructions
    ? `${basePrompt}\n\nAdditional instructions: ${customInstructions}`
    : basePrompt;

  enqueueSystemEvent(prompt, { sessionKey: params.sessionKey });
  return { shouldContinue: false };
};

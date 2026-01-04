import type { ClawdisConfig } from "../../config/config.js";
import type {
  GroupKeyResolution,
  SessionEntry,
} from "../../config/sessions.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";

export function resolveGroupRequireMention(params: {
  cfg: ClawdisConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): boolean {
  const { cfg, ctx, groupResolution } = params;
  const surface = groupResolution?.surface ?? ctx.Surface?.trim().toLowerCase();
  const groupId = groupResolution?.id ?? ctx.From?.replace(/^group:/, "");
  if (surface === "telegram") {
    if (groupId) {
      const groupConfig = cfg.telegram?.groups?.[groupId];
      if (typeof groupConfig?.requireMention === "boolean") {
        return groupConfig.requireMention;
      }
    }
    const groupDefault = cfg.telegram?.groups?.["*"]?.requireMention;
    if (typeof groupDefault === "boolean") return groupDefault;
    return true;
  }
  if (surface === "whatsapp") {
    if (groupId) {
      const groupConfig = cfg.whatsapp?.groups?.[groupId];
      if (typeof groupConfig?.requireMention === "boolean") {
        return groupConfig.requireMention;
      }
    }
    const groupDefault = cfg.whatsapp?.groups?.["*"]?.requireMention;
    if (typeof groupDefault === "boolean") return groupDefault;
    return true;
  }
  if (surface === "imessage") {
    if (groupId) {
      const groupConfig = cfg.imessage?.groups?.[groupId];
      if (typeof groupConfig?.requireMention === "boolean") {
        return groupConfig.requireMention;
      }
    }
    const groupDefault = cfg.imessage?.groups?.["*"]?.requireMention;
    if (typeof groupDefault === "boolean") return groupDefault;
    return true;
  }
  return true;
}

export function defaultGroupActivation(
  requireMention: boolean,
): "always" | "mention" {
  return requireMention === false ? "always" : "mention";
}

export function buildGroupIntro(params: {
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentToken: string;
}): string {
  const activation =
    normalizeGroupActivation(params.sessionEntry?.groupActivation) ??
    params.defaultActivation;
  const subject = params.sessionCtx.GroupSubject?.trim();
  const members = params.sessionCtx.GroupMembers?.trim();
  const surface = params.sessionCtx.Surface?.trim().toLowerCase();
  const surfaceLabel = (() => {
    if (!surface) return "chat";
    if (surface === "whatsapp") return "WhatsApp";
    if (surface === "telegram") return "Telegram";
    if (surface === "discord") return "Discord";
    if (surface === "webchat") return "WebChat";
    return `${surface.at(0)?.toUpperCase() ?? ""}${surface.slice(1)}`;
  })();
  const subjectLine = subject
    ? `You are replying inside the ${surfaceLabel} group "${subject}".`
    : `You are replying inside a ${surfaceLabel} group chat.`;
  const membersLine = members ? `Group members: ${members}.` : undefined;
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const silenceLine =
    activation === "always"
      ? `If no response is needed, reply with exactly "${params.silentToken}" (no other text) so Clawdis stays silent.`
      : undefined;
  const cautionLine =
    activation === "always"
      ? "Be extremely selective: reply only when you are directly addressed, asked a question, or can add clear value. Otherwise stay silent."
      : undefined;
  const lurkLine =
    "Be a good group participant: lurk and follow the conversation, but only chime in when you have something genuinely helpful or relevant to add. Don't feel obligated to respond to every message — quality over quantity. Even when lurking silently, you can use emoji reactions to acknowledge messages, show support, or react to humor — reactions are always appreciated and don't clutter the chat.";
  return [
    subjectLine,
    membersLine,
    activationLine,
    silenceLine,
    cautionLine,
    lurkLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}

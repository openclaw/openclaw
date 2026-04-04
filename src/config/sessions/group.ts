import type { MsgContext } from "../../auto-reply/templating.js";
import { getBundledChannelContractSurfaces } from "../../channels/plugins/contract-surfaces.js";
import { normalizeHyphenSlug } from "../../shared/string-normalization.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

type LegacyGroupSessionSurface = {
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => GroupKeyResolution | null;
};

function resolveLegacyWhatsAppGroupId(from: string): string | null {
  const candidate = from.trim().replace(/^whatsapp:/i, "");
  if (!candidate.toLowerCase().endsWith("@g.us")) {
    return null;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  return /^[0-9]+(-[0-9]+)*$/i.test(localPart) ? `${localPart}@g.us` : null;
}

function resolveLegacyGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  for (const surface of getBundledChannelContractSurfaces() as LegacyGroupSessionSurface[]) {
    const resolved = surface.resolveLegacyGroupSessionKey?.(ctx);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function normalizeGroupLabel(raw?: string) {
  return normalizeHyphenSlug(raw);
}

function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = (params.provider?.trim().toLowerCase() || "group").trim();
  const groupChannel = params.groupChannel?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  const detail =
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key;
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const normalizedChatType =
    chatType === "channel" ? "channel" : chatType === "group" ? "group" : undefined;
  const legacyWhatsAppGroupId = resolveLegacyWhatsAppGroupId(from);

  const legacyResolution = resolveLegacyGroupSessionKey(ctx);
  const looksLikeGroup =
    normalizedChatType === "group" ||
    normalizedChatType === "channel" ||
    from.includes(":group:") ||
    from.includes(":channel:") ||
    legacyWhatsAppGroupId !== null ||
    legacyResolution !== null;
  if (!looksLikeGroup) {
    return null;
  }

  const providerHint = ctx.Provider?.trim().toLowerCase();

  const parts = from.split(":").filter(Boolean);
  const head = parts[0]?.trim().toLowerCase() ?? "";
  const headIsSurface = head ? getGroupSurfaces().has(head) : false;

  if (!headIsSurface && !providerHint && legacyResolution) {
    return legacyResolution;
  }

  if (!headIsSurface && legacyWhatsAppGroupId) {
    return {
      key: `whatsapp:group:${legacyWhatsAppGroupId}`,
      channel: "whatsapp",
      id: legacyWhatsAppGroupId,
      chatType: "group",
    };
  }

  const provider = headIsSurface ? head : (providerHint ?? legacyResolution?.channel);
  if (!provider) {
    return null;
  }

  const second = parts[1]?.trim().toLowerCase();
  const secondIsKind = second === "group" || second === "channel";
  const kind = secondIsKind
    ? second
    : from.includes(":channel:") || normalizedChatType === "channel"
      ? "channel"
      : "group";
  const id = headIsSurface
    ? secondIsKind
      ? parts.slice(2).join(":")
      : parts.slice(1).join(":")
    : from;
  const finalId = id.trim().toLowerCase();
  if (!finalId) {
    return null;
  }

  return {
    key: `${provider}:${kind}:${finalId}`,
    channel: provider,
    id: finalId,
    chatType: kind === "channel" ? "channel" : "group",
  };
}

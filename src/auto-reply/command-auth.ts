import type { ClawdbotConfig } from "../config/config.js";
import { normalizeE164 } from "../utils.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  isWhatsAppProvider: boolean;
  ownerList: string[];
  senderE164?: string;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  commandAuthorized: boolean;
}): CommandAuthorization {
  const { ctx, cfg, commandAuthorized } = params;
  const provider = (ctx.Provider ?? "").trim().toLowerCase();
  const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
  const to = (ctx.To ?? "").replace(/^whatsapp:/, "");
  const hasWhatsappPrefix =
    (ctx.From ?? "").startsWith("whatsapp:") ||
    (ctx.To ?? "").startsWith("whatsapp:");
  const looksLikeE164 = (value: string) =>
    Boolean(value && /^\+?\d{3,}$/.test(value.replace(/[^\d+]/g, "")));
  const inferWhatsApp =
    !provider &&
    Boolean(cfg.whatsapp?.allowFrom?.length) &&
    (looksLikeE164(from) || looksLikeE164(to));
  const isWhatsAppProvider =
    provider === "whatsapp" || hasWhatsappPrefix || inferWhatsApp;

  const configuredAllowFrom = isWhatsAppProvider
    ? cfg.whatsapp?.allowFrom
    : undefined;
  const allowFromList =
    configuredAllowFrom?.filter((entry) => entry?.trim()) ?? [];
  const allowAll =
    !isWhatsAppProvider ||
    allowFromList.length === 0 ||
    allowFromList.some((entry) => entry.trim() === "*");

  const senderE164 = normalizeE164(
    ctx.SenderE164 ?? (isWhatsAppProvider ? from : ""),
  );
  const ownerCandidates =
    isWhatsAppProvider && !allowAll
      ? allowFromList.filter((entry) => entry !== "*")
      : [];
  if (isWhatsAppProvider && !allowAll && ownerCandidates.length === 0 && to) {
    ownerCandidates.push(to);
  }
  const ownerList = ownerCandidates
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));

  const isOwner =
    !isWhatsAppProvider ||
    allowAll ||
    ownerList.length === 0 ||
    (senderE164 ? ownerList.includes(senderE164) : false);
  const isAuthorizedSender = commandAuthorized && isOwner;

  return {
    isWhatsAppProvider,
    ownerList,
    senderE164: senderE164 || undefined,
    isAuthorizedSender,
    from: from || undefined,
    to: to || undefined,
  };
}

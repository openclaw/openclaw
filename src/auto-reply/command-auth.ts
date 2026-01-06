import type { ClawdbotConfig } from "../config/config.js";
import { normalizeE164 } from "../utils.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  isWhatsAppSurface: boolean;
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
  const allowFromList =
    configuredAllowFrom?.filter((entry) => entry?.trim()) ?? [];
  const allowAll =
    !isWhatsAppSurface ||
    allowFromList.length === 0 ||
    allowFromList.some((entry) => entry.trim() === "*");

  const senderE164 = normalizeE164(ctx.SenderE164 ?? "");
  const ownerCandidates =
    isWhatsAppSurface && !allowAll
      ? allowFromList.filter((entry) => entry !== "*")
      : [];
  if (isWhatsAppSurface && !allowAll && ownerCandidates.length === 0 && to) {
    ownerCandidates.push(to);
  }
  const ownerList = ownerCandidates
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));

  const isOwner =
    !isWhatsAppSurface ||
    allowAll ||
    ownerList.length === 0 ||
    (senderE164 ? ownerList.includes(senderE164) : false);
  const isAuthorizedSender = commandAuthorized && isOwner;

  return {
    isWhatsAppSurface,
    ownerList,
    senderE164: senderE164 || undefined,
    isAuthorizedSender,
    from: from || undefined,
    to: to || undefined,
  };
}

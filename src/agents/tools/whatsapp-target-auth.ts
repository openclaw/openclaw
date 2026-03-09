import type { OpenClawConfig } from "../../config/config.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { resolveWhatsAppOutboundTarget } from "../../whatsapp/resolve-outbound-target.js";
import { ToolAuthorizationError } from "./common.js";

export function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): { to: string; accountId: string } {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const resolution = resolveWhatsAppOutboundTarget({
    to: params.chatJid,
    allowFrom: account.allowFrom ?? [],
    mode: "implicit",
  });
  if (!resolution.ok) {
    throw new ToolAuthorizationError(
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowFrom list for account "${account.accountId}".`,
    );
  }
  return { to: resolution.to, accountId: account.accountId };
}

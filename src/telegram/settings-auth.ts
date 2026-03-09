import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramDirectConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { isSenderAllowed, normalizeDmAllowFromWithStore } from "./bot-access.js";

/**
 * Shared auth decision for both the /settings command and cfg_* callback paths.
 *
 * Accepts the resolved event auth context (from resolveTelegramGroupAllowFromContext
 * or resolveTelegramEventAuthorizationContext) and produces an allow/deny decision
 * identical to the command path in resolveTelegramCommandAuth.
 *
 * By using a single function for both paths, we guarantee auth parity:
 * any change to the auth logic automatically applies to commands and callbacks.
 */
export function resolveSettingsAuthDecision(params: {
  chatId: number;
  accountId: string;
  senderId: string;
  senderUsername: string;
  cfg: OpenClawConfig;
  allowFrom?: Array<string | number>;
  // From event auth context (resolveTelegramEventAuthorizationContext output)
  effectiveDmPolicy: string;
  storeAllowFrom: string[];
  dmThreadId?: number;
  groupConfig?: { requireTopic?: boolean; dmPolicy?: string; allowFrom?: Array<string | number> };
  groupAllowOverride?: Array<string | number>;
}): { authorized: boolean; reason?: string } {
  const {
    chatId,
    accountId,
    senderId,
    senderUsername,
    cfg,
    allowFrom,
    effectiveDmPolicy,
    storeAllowFrom,
    dmThreadId,
    groupConfig,
    groupAllowOverride,
  } = params;

  // Enforce requireTopic for DM-topic deployments (mirrors command path).
  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  if (requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram settings in DM ${chatId}: requireTopic=true but no topic present`);
    return { authorized: false, reason: "require-topic" };
  }

  // Prefer per-DM/topic allowFrom override (mirrors command path).
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const dmSenderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });

  // Mirror /settings command handler auth: use resolveCommandAuthorizedFromAuthorizers
  // so that when no allowlist is configured and access groups are off,
  // commandAuthorized=true (open access).
  const commandsAllowFrom = cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;

  const commandAuthorized = commandsAllowFromConfigured
    ? Boolean(
        resolveCommandAuthorization({
          ctx: {
            Provider: "telegram",
            Surface: "telegram",
            OriginatingChannel: "telegram",
            AccountId: accountId,
            ChatType: "direct",
            From: `telegram:${chatId}`,
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
          },
          cfg,
          commandAuthorized: false,
        })?.isAuthorizedSender,
      )
    : resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: dmAllow.hasEntries, allowed: dmSenderAllowed }],
        modeWhenAccessGroupsOff: "configured",
      });

  // Enforce both commands.allowFrom and commands.ownerAllowFrom in a single check.
  const commandsAuth = resolveCommandAuthorization({
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      AccountId: accountId,
      ChatType: "direct",
      From: `telegram:${chatId}`,
      SenderId: senderId || undefined,
      SenderUsername: senderUsername || undefined,
    },
    cfg,
    commandAuthorized,
  });

  if (!commandsAuth.isAuthorizedSender) {
    return { authorized: false, reason: "not-authorized" };
  }

  return { authorized: true };
}

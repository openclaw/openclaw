import type { OpenClawConfig } from "../config/config.js";
import { listSlackAccountIds, resolveSlackAccount } from "./accounts.js";

function resolveInteractiveRepliesFromCapabilities(capabilities: unknown): boolean {
  if (!capabilities) {
    return false;
  }
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "interactivereplies",
    );
  }
  if (typeof capabilities === "object") {
    return (capabilities as { interactiveReplies?: unknown }).interactiveReplies === true;
  }
  return false;
}

export function isSlackInteractiveRepliesEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
    return resolveInteractiveRepliesFromCapabilities(account.config.capabilities);
  }
  const accountIds = listSlackAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveInteractiveRepliesFromCapabilities(params.cfg.channels?.slack?.capabilities);
  }
  if (accountIds.length > 1) {
    return false;
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: accountIds[0] });
  return resolveInteractiveRepliesFromCapabilities(account.config.capabilities);
}

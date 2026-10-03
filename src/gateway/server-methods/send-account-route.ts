import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import { normalizeAccountId } from "../../routing/session-key.js";

export async function resolveMessageOperationAccountRoute(params: {
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  accountIds: readonly unknown[];
  conflictMessage: string;
}): Promise<{ accountId: string | undefined; effectiveAccountId: string; requestScope: string }> {
  const accountIds = new Set<string>();
  for (const requestedAccountId of params.accountIds) {
    const accountId = await validateExplicitMessageAccountSelection({
      cfg: params.cfg,
      channel: params.channel,
      accountId: requestedAccountId,
      plugin: params.plugin,
    });
    if (accountId !== undefined) {
      accountIds.add(accountId);
    }
  }
  if (accountIds.size > 1) {
    throw new Error(params.conflictMessage);
  }
  const accountId = accountIds.values().next().value;
  // Missing input remains host-derived authority; this value only canonicalizes
  // idempotency and is not forwarded as a caller-supplied explicit selection.
  const effectiveAccountId =
    accountId ??
    normalizeAccountId(resolveChannelDefaultAccountId({ plugin: params.plugin, cfg: params.cfg }));
  return {
    accountId,
    effectiveAccountId,
    requestScope: JSON.stringify([params.channel, effectiveAccountId]),
  };
}

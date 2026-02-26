import {
  resolveThreadBindingSessionTtlMs,
  resolveThreadBindingsEnabled,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";

export { resolveThreadBindingSessionTtlMs, resolveThreadBindingsEnabled };

export function resolveDiscordThreadBindingSessionTtlMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number {
  const accountId = normalizeAccountId(params.accountId);
  const root = params.cfg.channels?.discord?.threadBindings;
  const account = params.cfg.channels?.discord?.accounts?.[accountId]?.threadBindings;
  return resolveThreadBindingSessionTtlMs({
    channelTtlHoursRaw: account?.ttlHours ?? root?.ttlHours,
    sessionTtlHoursRaw: params.cfg.session?.threadBindings?.ttlHours,
  });
}

import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import type { HookAgentDispatchPayload } from "../hooks.js";

/**
 * Binds a direct hook announce to a concrete outbound account before the
 * isolated run is scheduled; partial or last targets stay unmapped and defer
 * to cron's own delivery resolution.
 */
export async function validateHookAgentDeliveryAccount(params: {
  cfg: OpenClawConfig;
  value: HookAgentDispatchPayload;
}): Promise<HookAgentDispatchPayload> {
  // Mapped hooks can defer partial/last targets to cron and cannot select an account.
  // Bind only direct hook announces whose destination is already complete.
  if (
    params.value.delivery.mode !== "announce" ||
    params.value.delivery.channel === "last" ||
    !params.value.delivery.to
  ) {
    return params.value;
  }
  const accountId = params.value.delivery.accountId
    ? await validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: params.value.delivery.channel,
        accountId: params.value.delivery.accountId,
      })
    : (() => {
        const plugin = resolveOutboundChannelPlugin({
          channel: params.value.delivery.channel,
          cfg: params.cfg,
        });
        if (!plugin) {
          throw new Error(`Channel ${params.value.delivery.channel} is unavailable.`);
        }
        return resolveChannelDefaultAccountId({ plugin, cfg: params.cfg });
      })();
  if (!accountId) {
    throw new Error(`Channel ${params.value.delivery.channel} did not resolve an account.`);
  }
  return {
    ...params.value,
    accountId,
    delivery: { ...params.value.delivery, accountId },
  };
}

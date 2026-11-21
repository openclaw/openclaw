/** Target facts message.action resolves with the Gateway's loaded channel plugin. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/message-action-names.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImplicitMessageActionTarget } from "../../infra/outbound/message-action-normalization.js";
import { resolveMessageTarget } from "../../infra/outbound/message-action-routing.js";
import { actionHasTarget } from "../../infra/outbound/message-action-spec.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";

export async function prepareGatewayMessageActionTarget(params: {
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  action: string;
  actionParams: Record<string, unknown>;
  accountId?: string;
  canonicalAction: boolean;
  conversationReadOrigin: ConversationReadInvocationOrigin;
  toolContext?: ChannelThreadingToolContext;
}): Promise<void> {
  const { cfg, channel, plugin, accountId, actionParams } = params;
  if (params.canonicalAction) {
    if (
      params.action === "send" &&
      !normalizeOptionalString(actionParams.target) &&
      !actionHasTarget("send", actionParams, {
        channel,
        aliasSpec: plugin.actions?.messageActionTargetAliases?.send ?? null,
      }) &&
      !resolveImplicitMessageActionTarget(params.toolContext)
    ) {
      // Native sends could use account defaults without a target. Resolve that
      // owner fact before core routing requires it.
      const target = await resolveOutboundTarget({ channel, plugin, cfg, accountId });
      if (!target.ok) {
        throw target.error;
      }
      actionParams.to = target.to;
    }
    return;
  }
  const action = CHANNEL_MESSAGE_ACTION_NAMES.find((name) => name === params.action);
  if (
    action &&
    params.conversationReadOrigin === "direct-operator" &&
    (plugin.messaging?.targetResolver || plugin.directory)
  ) {
    // An operator CLI with a runtime-free channel adapter defers target lookup to
    // this loaded plugin. A target that is already canonical resolves to itself.
    await resolveMessageTarget({ cfg, channel, action, args: actionParams, accountId, plugin });
  }
}

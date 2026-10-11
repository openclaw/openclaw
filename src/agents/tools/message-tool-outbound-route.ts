import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { buildTurnSendTargetKey } from "./turn-send-ledger.js";

// Collapse a raw target candidate to the same canonical form the delivery path (and the
// ledger key via buildTurnSendTargetKey) resolves it to: case-fold, plugin prefix strip,
// phone normalization. Equivalent spellings of one destination ("TG:12345" vs "12345",
// or "target" and a plugin delivery alias that name the same peer) must collapse to one
// entry in the distinct-target set below instead of looking like two targets and forcing
// the multi-target bail that silently drops the send out of the budget. Provider-bound and
// idempotent, so reapplying it where buildTurnSendTargetKey normalizes again is a no-op;
// genuinely different destinations normalize differently and stay distinct. Falls back to
// the coerced input when the normalizer cannot parse it, so a candidate still compares by
// its own value rather than vanishing.
function canonicalizeRouteTarget(channel: string, raw: string): string {
  return normalizeTargetForProvider(channel, raw) ?? raw;
}

// Canonical, stable route string for one outbound action: `${channel}\0${account}\0${target}`,
// with the current source resolved to its concrete target and multi-target sends bailing to
// undefined. Keys the per-turn send ledger on the same normalized destination as
// conversations_send does for the same peer. `resolveAccountId` receives the channel and the
// destination as the caller spelled it (binding lookups match exact peer ids) and returns the
// account delivery will use. Returns undefined when the route cannot be resolved to a single
// destination.
export function resolveOutboundActionRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  resolveAccountId: (route: { channel: string; target: string }) => string | undefined;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return undefined;
  }
  const rawTargets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  const targets = rawTargets.map((value) => canonicalizeRouteTarget(channel, value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId]
      .filter((value): value is string => Boolean(value))
      .map((value) => canonicalizeRouteTarget(channel, value)),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core. A no-target
  // or current-source send resolves to the concrete current target so it shares one
  // ledger slot with conversations_send to the same peer; fail open when that target is
  // unknown, mirroring the multi-target bail. Provider/account keys prevent cross-send suppression.
  const currentSourceTarget = params.currentMessagingTarget ?? params.currentChannelId;
  const isCurrentSource = !target || currentTargets.has(target);
  const routeTarget = isCurrentSource ? currentSourceTarget : target;
  if (!routeTarget) {
    return undefined;
  }
  const accountId = params.resolveAccountId({
    channel,
    target: (isCurrentSource ? undefined : rawTargets[0]) ?? routeTarget,
  });
  return buildTurnSendTargetKey({ channel, accountId, target: routeTarget });
}

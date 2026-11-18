import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "../../infra/outbound/channel-target-prefix.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

/** Only a matching conversation may supply provider-specific routing context. */
export function selectCronRouteCurrentSessionKey(
  sessionKey: string | undefined,
  agentId: string,
  deliveryProvider: string,
  deliveryTarget: string,
): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || parsed.agentId !== agentId) {
    return undefined;
  }
  const conversation = /^([^:]+):(direct|group|channel):([^:]+)(?::(?:thread|topic):.+)?$/i.exec(
    parsed.rest,
  );
  const peerId = stripOutboundTargetKindPrefix(
    stripTargetProviderPrefix(deliveryTarget, deliveryProvider),
  );
  return conversation?.[1]?.toLowerCase() === deliveryProvider.toLowerCase() &&
    conversation[3] === peerId
    ? sessionKey
    : undefined;
}

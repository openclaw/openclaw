import { bindCommandOwnerAuthority } from "../../auto-reply/command-owner-authority.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { takeChannelParticipantInput } from "./admission-evidence.js";
import type { ChannelIngressHostOwner } from "./ingress-host-owner.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

export function bindChannelParticipantInput(params: {
  context: MsgContext;
  channelId: string;
  ingress:
    | ResolvedChannelMessageIngress
    | readonly ResolvedChannelMessageIngress[]
    | "unsupported"
    | undefined;
  binding: ChannelIngressContextBinding;
  owner: ChannelIngressHostOwner;
}): void {
  if (!params.ingress || params.ingress === "unsupported") {
    return;
  }
  const resolutions = Array.isArray(params.ingress) ? params.ingress : [params.ingress];
  const batch = resolutions.map(takeChannelParticipantInput);
  // Batched ingress uses the final transport message id; every source keeps its own accepted time.
  if (
    batch.at(-1)?.binding.messageId !== params.binding.messageId ||
    !params.owner.isLive() ||
    batch.some(
      (input) =>
        !input ||
        input.owner !== params.owner ||
        input.gatewayContext !== params.owner.resolveGatewayContext?.() ||
        input.identity.pluginId !== params.channelId ||
        input.binding.agentId !== params.binding.agentId ||
        input.binding.sessionKey !== params.binding.sessionKey ||
        input.binding.nativeChannelId !== params.binding.nativeChannelId ||
        input.binding.inboundEventKind !== params.binding.inboundEventKind,
    )
  ) {
    return;
  }
  for (const input of batch) {
    if (input) {
      prepareSessionParticipantInput(params.context, input.identity, input.promptedAt);
    }
  }
  const principal = batch.at(-1)?.verifiedPrincipal;
  const principalKey = principal && JSON.stringify(principal);
  const gateway = params.owner.resolveGatewayContext?.();
  if (
    !principal ||
    !gateway ||
    batch.some((input) => JSON.stringify(input?.verifiedPrincipal) !== principalKey)
  ) {
    return;
  }
  const authority = batch.at(-1)?.commandOwnerAuthority;
  if (!authority?.source || !authority.isCurrent(gateway.getRuntimeConfig())) {
    return;
  }
  bindCommandOwnerAuthority(params.context, {
    isCurrent: () =>
      params.owner.isLive() &&
      params.owner.resolveGatewayContext?.() === gateway &&
      authority.isCurrent(gateway.getRuntimeConfig()),
  });
}

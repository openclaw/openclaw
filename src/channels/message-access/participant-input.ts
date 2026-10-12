import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { bindRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { captureChannelOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/account-id.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { takeChannelParticipantInput } from "./admission-evidence.js";
import { bindChildSessionPublication } from "./child-session-publication.js";
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
  // Public intent is stricter than ordinary attribution: no mixed/batched context.
  const publication = batch.length === 1 ? batch[0]?.childSessionPublication : undefined;
  if (publication?.audience === "public" && params.binding.inboundEventKind === "user_request") {
    const gateway = params.owner.resolveGatewayContext?.();
    bindChildSessionPublication(params.context, params.binding.sessionKey, () => {
      if (
        !params.owner.isLive() ||
        !gateway ||
        params.owner.resolveGatewayContext?.() !== gateway
      ) {
        throw new Error("Public ingress owner is no longer current.");
      }
      publication.assertCurrent();
    });
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
  const requester = batch.at(-1)?.requesterProfile;
  if (
    requester &&
    params.context.SenderId === principal.senderId &&
    (params.context.AccountId ?? DEFAULT_ACCOUNT_ID) === principal.accountId &&
    params.context.OriginatingChannel === principal.channelId &&
    batch.every(
      (input) => input?.requesterProfile?.id === requester.id && input.requesterProfile.isCurrent(),
    )
  ) {
    bindRequesterProfile(params.context, {
      ...requester,
      isCurrent: () =>
        params.owner.isLive() &&
        params.owner.resolveGatewayContext?.() === gateway &&
        batch.every((input) => input?.requesterProfile?.isCurrent()),
    });
  }
  const authority = batch.at(-1)?.commandOwnerAuthority;
  if (!authority?.source || !authority.isCurrent(gateway.getRuntimeConfig())) {
    return;
  }
  bindCommandOwnerAuthority(params.context, {
    recoveryReference: authority.recoveryReference,
    isCurrent: () =>
      params.owner.isLive() &&
      params.owner.resolveGatewayContext?.() === gateway &&
      authority.isCurrent(gateway.getRuntimeConfig()),
  });
  const assertCurrent = captureCommandOwnerAssertion(params.context);
  const commandOwner = getCommandOwnerAuthority(params.context);
  if (authority.operatorProfile && assertCurrent && commandOwner) {
    bindCommandOwnerAuthority(params.context, {
      ...commandOwner,
      operatorAuthority: captureChannelOperatorRunAuthority({
        ...authority.operatorProfile,
        getRuntimeConfig: () => gateway.getRuntimeConfig(),
        assertCurrent,
        signal: authority.signal,
      }),
    });
  }
}

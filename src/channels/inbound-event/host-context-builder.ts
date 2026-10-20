import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
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
import {
  bindHostChannelContextAdmissionEvidence,
  prepareHostChannelContextAdmissionEvidence,
  takeChannelParticipantInput,
} from "../message-access/admission-evidence.js";
import { bindChildSessionPublication } from "../message-access/child-session-publication.js";
import type { ChannelIngressHostOwner } from "../message-access/ingress-host-owner.js";
import type { ChannelIngressContextBinding } from "../message-access/runtime-types.js";

type HostContextParams = {
  channel: string;
  accountId?: string;
  channelIngress?: Parameters<typeof prepareHostChannelContextAdmissionEvidence>[0]["ingress"];
  sender: { id?: string | number | null };
  route: { agentId: string; routeSessionKey: string; dispatchSessionKey?: string };
  reply: { nativeChannelId?: string };
  conversation: { nativeChannelId?: string };
  messageId?: string;
  message: { inboundEventKind?: "user_request" | "room_event" };
};
type MaybePromise<T> = T | Promise<T>;
/** Wrap the ordinary builder with the private bundled-channel evidence binding. */
export function createHostChannelInboundEventContextBuilder<
  Params extends HostContextParams,
  Built extends MsgContext,
>(
  buildContext: (params: Params) => MaybePromise<Built>,
  owner?: ChannelIngressHostOwner,
): (params: Params) => MaybePromise<Built> {
  return (params) => {
    const preparation = prepareHostChannelContextAdmissionEvidence({
      owner,
      channelId: params.channel,
      accountId: params.accountId,
      ingress: params.channelIngress,
      rawPrincipalRef: params.sender.id,
      contextParams: params,
    });
    const result = buildContext(params);
    const bindEvidence = (built: Built) => {
      if (owner?.channelId === params.channel) {
        const binding: ChannelIngressContextBinding = {
          agentId: params.route.agentId,
          sessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
          nativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
          messageId: params.messageId,
          inboundEventKind: params.message.inboundEventKind ?? "user_request",
        };
        const bindParticipants = () => {
          if (!params.channelIngress || params.channelIngress === "unsupported") {
            return;
          }
          const resolutions = Array.isArray(params.channelIngress)
            ? params.channelIngress
            : [params.channelIngress];
          const batch = resolutions.map(takeChannelParticipantInput);
          // Batched ingress uses the final transport message id; every source keeps its own accepted time.
          if (
            batch.at(-1)?.binding.messageId !== binding.messageId ||
            !owner.isLive() ||
            batch.some(
              (input) =>
                !input ||
                input.owner !== owner ||
                input.gatewayContext !== owner.resolveGatewayContext?.() ||
                input.identity.pluginId !== params.channel ||
                input.binding.agentId !== binding.agentId ||
                input.binding.sessionKey !== binding.sessionKey ||
                input.binding.nativeChannelId !== binding.nativeChannelId ||
                input.binding.inboundEventKind !== binding.inboundEventKind,
            )
          ) {
            return;
          }
          for (const input of batch) {
            if (input) {
              prepareSessionParticipantInput(built, input.identity, input.promptedAt);
            }
          }
          // Public intent is stricter than ordinary attribution: no mixed/batched context.
          const publication = batch.length === 1 ? batch[0]?.childSessionPublication : undefined;
          if (publication?.audience === "public" && binding.inboundEventKind === "user_request") {
            const gateway = owner.resolveGatewayContext?.();
            const ownerIsCurrent = () =>
              owner.isLive() && Boolean(gateway) && owner.resolveGatewayContext?.() === gateway;
            const assertOwnerCurrent = () => {
              if (!ownerIsCurrent()) {
                throw new Error("Public ingress owner is no longer current.");
              }
            };
            const prepare = publication.prepare;
            bindChildSessionPublication(
              built,
              binding.sessionKey,
              () => {
                assertOwnerCurrent();
                publication.assertCurrent();
              },
              prepare
                ? async () => {
                    if (!ownerIsCurrent()) {
                      return null;
                    }
                    const assertCurrent = await prepare();
                    if (!ownerIsCurrent() || !assertCurrent) {
                      return null;
                    }
                    return () => {
                      assertOwnerCurrent();
                      assertCurrent();
                    };
                  }
                : undefined,
            );
          }
          const principal = batch.at(-1)?.verifiedPrincipal;
          const principalKey = principal && JSON.stringify(principal);
          const gateway = owner.resolveGatewayContext?.();
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
            built.SenderId === principal.senderId &&
            (built.AccountId ?? DEFAULT_ACCOUNT_ID) === principal.accountId &&
            built.OriginatingChannel === principal.channelId &&
            batch.every(
              (input) =>
                input?.requesterProfile?.id === requester.id && input.requesterProfile.isCurrent(),
            )
          ) {
            bindRequesterProfile(built, {
              ...requester,
              isCurrent: () =>
                owner.isLive() &&
                owner.resolveGatewayContext?.() === gateway &&
                batch.every((input) => input?.requesterProfile?.isCurrent()),
            });
          }
          const authority = batch.at(-1)?.commandOwnerAuthority;
          if (!authority?.source || !authority.isCurrent(gateway.getRuntimeConfig())) {
            return;
          }
          bindCommandOwnerAuthority(built, {
            recoveryReference: authority.recoveryReference,
            isCurrent: () =>
              owner.isLive() &&
              owner.resolveGatewayContext?.() === gateway &&
              authority.isCurrent(gateway.getRuntimeConfig()),
          });
          const assertCurrent = captureCommandOwnerAssertion(built);
          const commandOwner = getCommandOwnerAuthority(built);
          if (authority.operatorProfile && assertCurrent && commandOwner) {
            bindCommandOwnerAuthority(built, {
              ...commandOwner,
              operatorAuthority: captureChannelOperatorRunAuthority({
                ...authority.operatorProfile,
                recoveryReference:
                  authority.recoveryReference?.version === 1
                    ? authority.recoveryReference
                    : undefined,
                getRuntimeConfig: () => gateway.getRuntimeConfig(),
                assertCurrent,
                signal: authority.signal,
              }),
            });
          }
        };
        bindParticipants();
      }
      bindHostChannelContextAdmissionEvidence({
        context: built,
        preparation,
      });
      return built;
    };
    return isPromiseLike(result) ? result.then(bindEvidence) : bindEvidence(result);
  };
}

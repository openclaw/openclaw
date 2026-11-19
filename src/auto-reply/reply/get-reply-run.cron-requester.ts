import { createCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { normalizeCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";

/** Map fresh native ingress identity, not message text or stored delivery, to a requester. */
export function resolveReplyCronChannelRequester(
  context: object,
  params: {
    channel?: string;
    senderId?: string;
    accountId?: string;
  },
) {
  const owner = getCommandOwnerAuthority(context);
  const principal = owner?.channelPrincipal;
  if (
    !principal ||
    !owner.isCurrent() ||
    principal.channelId !== params.channel ||
    principal.accountId !== normalizeAccountId(params.accountId) ||
    principal.senderId !== params.senderId
  ) {
    return undefined;
  }
  return normalizeCronAuthenticatedChannelRequester({
    version: 1,
    channel: principal.channelId,
    accountId: principal.accountId,
    senderId: principal.senderId,
  });
}

/** Capture the original source once; queued admission may refresh its live owner check. */
export function createReplyCronAuthorityFactory(
  context: object,
  params: Parameters<typeof resolveReplyCronChannelRequester>[1] & {
    channel: string;
  },
) {
  const authority = getCommandOwnerAuthority(context);
  const requester = resolveReplyCronChannelRequester(context, params);
  if (!authority || !requester) {
    return undefined;
  }
  const owner = {
    channel: requester.channel,
    accountId: requester.accountId,
    senderId: requester.senderId,
  };
  return (runId: string, isCurrentOwner = () => authority.isCurrent()) =>
    createCronCreatorAuthorityCapability(
      runId,
      { kind: "external", channel: params.channel },
      { source: "channel-owner", isCurrent: isCurrentOwner },
      undefined,
      requester,
      { isCurrent: isCurrentOwner, ...owner },
    );
}

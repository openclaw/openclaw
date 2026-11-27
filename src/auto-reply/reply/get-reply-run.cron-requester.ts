import { createCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { normalizeCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";

const log = createSubsystemLogger("cron");

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

/** Capture the original source once; a queued start checks its admitted owner once more. */
export function createReplyCronAuthorityFactory(
  context: object,
  params: Parameters<typeof resolveReplyCronChannelRequester>[1] & {
    channel: string;
  },
) {
  const authority = getCommandOwnerAuthority(context);
  const requester = resolveReplyCronChannelRequester(context, params);
  // A linked owner manages by its profile's grant; an asserted owner has no grant (owner list).
  const grant = authority?.operatorAuthority?.grant;
  if (!authority || !requester || (grant && grant.automations !== "manage")) {
    return undefined;
  }
  return (runId: string, isCurrentOwner = () => authority.isCurrent()) =>
    isCurrentOwner()
      ? createCronCreatorAuthorityCapability(
          runId,
          { kind: "external", channel: params.channel },
          { source: "channel-owner" },
          undefined,
          requester,
        )
      : undefined;
}

/**
 * A configured owner whose ingress identity the host did not bind keeps caller-scoped
 * automations. Record why: the tool itself only reports "cron job not found".
 */
export function logReplyCronOwnerWithoutAuthority(
  context: object,
  params: { channel?: string; accountId?: string },
): void {
  const owner = getCommandOwnerAuthority(context);
  const reason = !owner?.channelPrincipal
    ? "ingress-identity-unbound"
    : !owner.isCurrent()
      ? "owner-revoked"
      : (owner.operatorAuthority?.grant.automations ?? "manage") !== "manage"
        ? "grant-without-manage"
        : "ingress-identity-mismatch";
  log.info("cron: owner turn without management authority", {
    channel: params.channel,
    accountId: normalizeAccountId(params.accountId),
    reason,
  });
}

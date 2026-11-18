import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { getRuntimeConfig } from "../../config/config.js";
import { normalizeCronAuthenticatedChannelRequester } from "../../cron/tools-allow-provenance.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { isConfiguredCommandOwner } from "../command-auth.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";

/** Map fresh native ingress identity, not message text or stored delivery, to a requester. */
export function resolveReplyCronChannelRequester(
  context: object,
  params: {
    channel?: string;
    senderId?: string;
    accountId?: string;
    replyAccountId?: string;
  },
) {
  if (params.channel !== "discord" && params.channel !== "telegram") {
    return undefined;
  }
  if (params.channel === "telegram") {
    const owner = getCommandOwnerAuthority(context);
    const principal = owner?.channelPrincipal;
    if (
      !owner?.isCurrent() ||
      principal?.channelId !== "telegram" ||
      principal.accountId !== normalizeAccountId(params.accountId) ||
      principal.senderId !== params.senderId
    ) {
      return undefined;
    }
  }
  return normalizeCronAuthenticatedChannelRequester({
    version: 1,
    channel: params.channel,
    accountId: normalizeAccountId(
      params.channel === "telegram" ? params.accountId : params.replyAccountId,
    ),
    senderId: params.senderId,
  });
}

/** Capture the original source once; queued admission may refresh its live owner check. */
export function createReplyCronAuthorityFactory(
  context: object,
  params: Parameters<typeof resolveReplyCronChannelRequester>[1] & {
    channel: string;
    commandSenderId?: string;
  },
) {
  const authority = getCommandOwnerAuthority(context);
  const requester = resolveReplyCronChannelRequester(context, params);
  if (params.channel === "telegram" && !requester) {
    return undefined;
  }
  const owner = {
    channel: params.channel,
    accountId: params.replyAccountId,
    senderId: normalizeOptionalString(params.commandSenderId),
  };
  const isCurrent = () =>
    authority?.isCurrent() ??
    (params.channel !== "telegram" && isConfiguredCommandOwner(getRuntimeConfig(), owner));
  return (runId: string, isCurrentOwner = isCurrent) =>
    createCronCreatorAuthorityCapability(
      runId,
      { kind: "external", channel: params.channel },
      { source: "channel-owner", isCurrent: isCurrentOwner },
      undefined,
      requester,
      { isCurrent: isCurrentOwner, ...owner },
    );
}

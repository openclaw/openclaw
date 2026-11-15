import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCommandSenderAuthority } from "./command-sender-authority.js";
import {
  type AllowFromParams,
  formatAllowFromList,
  resolveSenderCandidates,
} from "./sender-identity.js";

/** A requester restored for a scheduled occurrence. */
export type CommandsAllowFromRequester = {
  channel: string;
  accountId?: string;
  senderId?: string;
  commandSenderId?: string;
};

/** The sender inputs a live command's commands.allowFrom check reads from its context. */
export function readCommandsAllowFromSender(ctx: {
  SenderId?: string;
  AccountId?: string;
}): Omit<CommandsAllowFromRequester, "channel"> {
  return {
    commandSenderId: getCommandSenderAuthority(ctx)?.(),
    senderId: ctx.SenderId,
    accountId: ctx.AccountId,
  };
}

export function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

/** Shared by live authorization and the scheduled recheck so both select the same list. */
export function resolveCommandsAllowFromList(
  providerContext: AllowFromParams & { providerId: ChannelId | undefined },
): string[] | null {
  const commandsAllowFrom = providerContext.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return null;
  }
  const providerList = commandsAllowFrom[providerContext.providerId ?? ""];
  const globalList = commandsAllowFrom["*"];
  const rawList = Array.isArray(providerList) ? providerList : globalList;
  return Array.isArray(rawList)
    ? formatAllowFromList({ ...providerContext, allowFrom: rawList })
    : null;
}

/** Bundled plugin fallback: prefixed entries must normalize when the transport is not loaded. */
export function isCommandsAllowFromListed(
  cfg: OpenClawConfig,
  providerId: ChannelId | undefined,
  requester: CommandsAllowFromRequester,
): boolean {
  const plugin = providerId ? getChannelPlugin(providerId) : undefined;
  const providerContext = { plugin, cfg, accountId: requester.accountId, providerId };
  const list = resolveCommandsAllowFromList(providerContext);
  if (list === null) {
    return true;
  }
  const senderCandidates = resolveSenderCandidates({
    ...providerContext,
    senderId: requester.senderId,
    commandSenderId: requester.commandSenderId,
  });
  return list.some((entry) => isWildcardAllowFromEntry(entry) || senderCandidates.includes(entry));
}

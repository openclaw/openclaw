import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";

function hasAllowFromEntries(list?: Array<string | number>) {
  return (
    Array.isArray(list) && list.map((value) => String(value).trim()).filter(Boolean).length > 0
  );
}

export function detectEmptyAllowlistPolicy(cfg: OpenClawConfig): string[] {
  if (!isRecord(cfg.channels)) {
    return [];
  }

  const warnings: string[] = [];

  const usesSenderBasedGroupAllowlist = (channelName?: string): boolean => {
    if (!channelName) {
      return true;
    }
    // These channels enforce group access via channel/space config, not sender-based
    // groupAllowFrom lists.
    return !(channelName === "discord" || channelName === "slack" || channelName === "googlechat");
  };

  const allowsGroupAllowFromFallback = (channelName?: string): boolean => {
    if (!channelName) {
      return true;
    }
    // Keep doctor warnings aligned with runtime access semantics.
    return !(
      channelName === "googlechat" ||
      channelName === "imessage" ||
      channelName === "matrix" ||
      channelName === "msteams" ||
      channelName === "irc"
    );
  };

  const checkAccount = (
    account: Record<string, unknown>,
    prefix: string,
    parent?: Record<string, unknown>,
    channelName?: string,
  ) => {
    const dm = isRecord(account.dm) ? account.dm : undefined;
    const parentDm = isRecord(parent?.dm) ? parent.dm : undefined;
    const dmPolicy =
      (account.dmPolicy as string | undefined) ??
      (dm?.policy as string | undefined) ??
      (parent?.dmPolicy as string | undefined) ??
      (parentDm?.policy as string | undefined) ??
      undefined;

    const topAllowFrom =
      (account.allowFrom as Array<string | number> | undefined) ??
      (parent?.allowFrom as Array<string | number> | undefined);
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
    const parentNestedAllowFrom = parentDm?.allowFrom as Array<string | number> | undefined;
    const effectiveAllowFrom = topAllowFrom ?? nestedAllowFrom ?? parentNestedAllowFrom;

    if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) {
      warnings.push(
        `- ${prefix}.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to ${prefix}.allowFrom, or run "${formatCliCommand("openclaw doctor --fix")}" to auto-migrate from pairing store when entries exist.`,
      );
    }

    const groupPolicy =
      (account.groupPolicy as string | undefined) ??
      (parent?.groupPolicy as string | undefined) ??
      undefined;

    if (groupPolicy === "allowlist" && usesSenderBasedGroupAllowlist(channelName)) {
      const rawGroupAllowFrom =
        (account.groupAllowFrom as Array<string | number> | undefined) ??
        (parent?.groupAllowFrom as Array<string | number> | undefined);
      // Match runtime semantics: resolveGroupAllowFromSources treats
      // empty arrays as unset and falls back to allowFrom.
      const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
      const fallbackToAllowFrom = allowsGroupAllowFromFallback(channelName);
      const effectiveGroupAllowFrom =
        groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : undefined);

      if (!hasAllowFromEntries(effectiveGroupAllowFrom)) {
        if (fallbackToAllowFrom) {
          warnings.push(
            `- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom or ${prefix}.allowFrom, or set groupPolicy to "open".`,
          );
        } else {
          warnings.push(
            `- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom, or set groupPolicy to "open".`,
          );
        }
      }
    }
  };

  for (const [channelName, rawChannelConfig] of Object.entries(cfg.channels)) {
    if (!isRecord(rawChannelConfig)) {
      continue;
    }
    checkAccount(rawChannelConfig, `channels.${channelName}`, undefined, channelName);

    const accounts = isRecord(rawChannelConfig.accounts) ? rawChannelConfig.accounts : null;
    if (!accounts) {
      continue;
    }
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      if (!isRecord(rawAccount)) {
        continue;
      }
      checkAccount(
        rawAccount,
        `channels.${channelName}.accounts.${accountId}`,
        rawChannelConfig,
        channelName,
      );
    }
  }

  return warnings;
}

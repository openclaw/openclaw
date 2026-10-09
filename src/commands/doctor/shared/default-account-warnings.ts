import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "../../../channels/ids.js";
import { listRouteBindings } from "../../../config/bindings.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  formatChannelAccountsDefaultPath,
  formatSetExplicitDefaultInstruction,
  formatSetExplicitDefaultToConfiguredInstruction,
} from "../../../routing/default-account-warnings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../../routing/session-key.js";

type ChannelMissingDefaultAccountContext = {
  channelKey: string;
  channel: Record<string, unknown>;
  normalizedAccountIds: string[];
};

function normalizeBindingChannelKey(raw?: string | null): string {
  return normalizeChatChannelId(raw) || normalizeLowercaseStringOrEmpty(raw);
}

function collectChannelsMissingDefaultAccount(
  cfg: OpenClawConfig,
): ChannelMissingDefaultAccountContext[] {
  const contexts: ChannelMissingDefaultAccountContext[] = [];
  for (const [channelKey, rawChannel] of Object.entries(asNullableRecord(cfg.channels) ?? {})) {
    const channel = asNullableRecord(rawChannel);
    const accounts = asNullableRecord(channel?.accounts);
    if (!channel || !accounts) {
      continue;
    }

    const normalizedAccountIds = Array.from(
      new Set(Object.keys(accounts).map(normalizeAccountId)),
    ).toSorted((a, b) => a.localeCompare(b));
    if (normalizedAccountIds.length === 0 || normalizedAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
      continue;
    }
    contexts.push({ channelKey, channel, normalizedAccountIds });
  }
  return contexts;
}

export function collectMissingDefaultAccountBindingWarnings(cfg: OpenClawConfig): string[] {
  const bindings = listRouteBindings(cfg);
  return collectChannelsMissingDefaultAccount(cfg).flatMap(
    ({ channelKey, normalizedAccountIds }) => {
      const accountIdSet = new Set(normalizedAccountIds);
      const channelPattern = normalizeBindingChannelKey(channelKey);

      let hasWildcardBinding = false;
      const coveredAccountIds = new Set<string>();
      for (const binding of bindings) {
        const match = asNullableRecord(asNullableRecord(binding)?.match);
        if (!match) {
          continue;
        }

        const matchChannel =
          typeof match.channel === "string" ? normalizeBindingChannelKey(match.channel) : "";
        if (!matchChannel || matchChannel !== channelPattern) {
          continue;
        }

        const rawAccountId = normalizeOptionalString(match.accountId);
        if (!rawAccountId) {
          continue;
        }
        if (rawAccountId === "*") {
          hasWildcardBinding = true;
          continue;
        }
        const normalizedBindingAccountId = normalizeAccountId(rawAccountId);
        if (accountIdSet.has(normalizedBindingAccountId)) {
          coveredAccountIds.add(normalizedBindingAccountId);
        }
      }

      if (hasWildcardBinding) {
        return [];
      }

      const uncoveredAccountIds = normalizedAccountIds.filter(
        (accountId) => !coveredAccountIds.has(accountId),
      );
      if (uncoveredAccountIds.length === 0) {
        return [];
      }
      return [
        coveredAccountIds.size > 0
          ? `- channels.${channelKey}: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: ${uncoveredAccountIds.join(", ")}. Add bindings[].match.accountId for uncovered accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`
          : `- channels.${channelKey}: accounts.default is missing and no valid account-scoped binding exists for configured accounts (${normalizedAccountIds.join(", ")}). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`,
      ];
    },
  );
}

export function collectMissingExplicitDefaultAccountWarnings(cfg: OpenClawConfig): string[] {
  return collectChannelsMissingDefaultAccount(cfg).flatMap(
    ({ channelKey, channel, normalizedAccountIds }) => {
      if (normalizedAccountIds.length < 2) {
        return [];
      }

      const preferredDefault = normalizeOptionalAccountId(
        typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
      );
      if (preferredDefault && normalizedAccountIds.includes(preferredDefault)) {
        return [];
      }
      return [
        preferredDefault
          ? `- channels.${channelKey}: defaultAccount is set to "${preferredDefault}" but does not match configured accounts (${normalizedAccountIds.join(", ")}). ${formatSetExplicitDefaultToConfiguredInstruction({ channelKey })} to avoid fallback routing.`
          : `- channels.${channelKey}: multiple accounts are configured but no explicit default is set. ${formatSetExplicitDefaultInstruction(channelKey)} to avoid fallback routing.`,
      ];
    },
  );
}

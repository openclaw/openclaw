import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";

type OpenPolicyAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

function resolveAllowFromMode(channelName: string): OpenPolicyAllowFromMode {
  if (channelName === "googlechat") {
    return "nestedOnly";
  }
  if (channelName === "discord" || channelName === "slack") {
    return "topOrNested";
  }
  return "topOnly";
}

function hasWildcard(list?: Array<string | number>) {
  return list?.some((value) => String(value).trim() === "*") ?? false;
}

function ensureWildcard(
  account: Record<string, unknown>,
  prefix: string,
  mode: OpenPolicyAllowFromMode,
  changes: string[],
) {
  const dm = isRecord(account.dm) ? account.dm : undefined;
  const dmPolicy =
    (account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined) ?? undefined;

  if (dmPolicy !== "open") {
    return;
  }

  const topAllowFrom = account.allowFrom as Array<string | number> | undefined;
  const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;

  if (mode === "nestedOnly") {
    if (hasWildcard(nestedAllowFrom)) {
      return;
    }
    if (Array.isArray(nestedAllowFrom)) {
      nestedAllowFrom.push("*");
      changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
      return;
    }
    const nextDm = dm ?? {};
    nextDm.allowFrom = ["*"];
    account.dm = nextDm;
    changes.push(`- ${prefix}.dm.allowFrom: set to ["*"] (required by dmPolicy="open")`);
    return;
  }

  if (mode === "topOrNested") {
    if (hasWildcard(topAllowFrom) || hasWildcard(nestedAllowFrom)) {
      return;
    }

    if (Array.isArray(topAllowFrom)) {
      topAllowFrom.push("*");
      changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
    } else if (Array.isArray(nestedAllowFrom)) {
      nestedAllowFrom.push("*");
      changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
    } else {
      account.allowFrom = ["*"];
      changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
    }
    return;
  }

  if (hasWildcard(topAllowFrom)) {
    return;
  }
  if (Array.isArray(topAllowFrom)) {
    topAllowFrom.push("*");
    changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
  } else {
    account.allowFrom = ["*"];
    changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
  }
}

export function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextChannels = isRecord(next.channels) ? next.channels : null;
  if (!nextChannels) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];

  for (const [channelName, rawChannelConfig] of Object.entries(nextChannels)) {
    if (!isRecord(rawChannelConfig)) {
      continue;
    }

    const allowFromMode = resolveAllowFromMode(channelName);
    ensureWildcard(rawChannelConfig, `channels.${channelName}`, allowFromMode, changes);

    const accounts = isRecord(rawChannelConfig.accounts) ? rawChannelConfig.accounts : null;
    if (!accounts) {
      continue;
    }
    for (const [accountName, rawAccountConfig] of Object.entries(accounts)) {
      if (!isRecord(rawAccountConfig)) {
        continue;
      }
      ensureWildcard(
        rawAccountConfig,
        `channels.${channelName}.accounts.${accountName}`,
        allowFromMode,
        changes,
      );
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

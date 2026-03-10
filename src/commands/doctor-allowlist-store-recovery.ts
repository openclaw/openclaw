import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";

type AllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

function hasAllowFromEntries(list?: Array<string | number>) {
  return (
    Array.isArray(list) && list.map((value) => String(value).trim()).filter(Boolean).length > 0
  );
}

function resolveAllowFromMode(channelName: string): AllowFromMode {
  if (channelName === "googlechat") {
    return "nestedOnly";
  }
  if (channelName === "discord" || channelName === "slack") {
    return "topOrNested";
  }
  return "topOnly";
}

export async function maybeRepairAllowlistPolicyAllowFrom(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextChannels = isRecord(next.channels) ? next.channels : null;
  if (!nextChannels) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];

  const applyRecoveredAllowFrom = (params: {
    account: Record<string, unknown>;
    allowFrom: string[];
    mode: AllowFromMode;
    prefix: string;
  }) => {
    const count = params.allowFrom.length;
    const noun = count === 1 ? "entry" : "entries";

    if (params.mode === "nestedOnly") {
      const dm = isRecord(params.account.dm) ? params.account.dm : {};
      dm.allowFrom = params.allowFrom;
      params.account.dm = dm;
      changes.push(
        `- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
      );
      return;
    }

    if (params.mode === "topOrNested") {
      const dm = isRecord(params.account.dm) ? params.account.dm : undefined;
      const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
      if (dm && !Array.isArray(params.account.allowFrom) && Array.isArray(nestedAllowFrom)) {
        dm.allowFrom = params.allowFrom;
        changes.push(
          `- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
        );
        return;
      }
    }

    params.account.allowFrom = params.allowFrom;
    changes.push(
      `- ${params.prefix}.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
    );
  };

  const recoverAllowFromForAccount = async (params: {
    channelName: string;
    account: Record<string, unknown>;
    accountId?: string;
    prefix: string;
  }) => {
    const dm = isRecord(params.account.dm) ? params.account.dm : undefined;
    const dmPolicy =
      (params.account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined);
    if (dmPolicy !== "allowlist") {
      return;
    }

    const topAllowFrom = params.account.allowFrom as Array<string | number> | undefined;
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;
    if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) {
      return;
    }

    const normalizedChannelId = (normalizeChatChannelId(params.channelName) ?? params.channelName)
      .trim()
      .toLowerCase();
    if (!normalizedChannelId) {
      return;
    }
    const normalizedAccountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const fromStore = await readChannelAllowFromStore(
      normalizedChannelId,
      process.env,
      normalizedAccountId,
    ).catch(() => []);
    const recovered = Array.from(new Set(fromStore.map((entry) => String(entry).trim()))).filter(
      Boolean,
    );
    if (recovered.length === 0) {
      return;
    }

    applyRecoveredAllowFrom({
      account: params.account,
      allowFrom: recovered,
      mode: resolveAllowFromMode(params.channelName),
      prefix: params.prefix,
    });
  };

  for (const [channelName, rawChannelConfig] of Object.entries(nextChannels)) {
    if (!isRecord(rawChannelConfig)) {
      continue;
    }
    await recoverAllowFromForAccount({
      channelName,
      account: rawChannelConfig,
      prefix: `channels.${channelName}`,
    });

    const accounts = isRecord(rawChannelConfig.accounts) ? rawChannelConfig.accounts : null;
    if (!accounts) {
      continue;
    }
    for (const [accountId, rawAccountConfig] of Object.entries(accounts)) {
      if (!isRecord(rawAccountConfig)) {
        continue;
      }
      await recoverAllowFromForAccount({
        channelName,
        account: rawAccountConfig,
        accountId,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

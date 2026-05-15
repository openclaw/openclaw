import { resolveChannelDmAllowFrom } from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import { asObjectRecord } from "./object.js";

const PSEUDO_CHANNEL_KEYS = new Set(["defaults", "modelByChannel", "tools"]);

type ChannelRecord = Record<string, unknown>;

function isDisabled(record: ChannelRecord): boolean {
  return record.enabled === false;
}

function normalizeAllowFrom(raw: unknown): string[] {
  return Array.from(new Set(normalizeStringEntries(Array.isArray(raw) ? raw : [])));
}

function readGroupAllowFrom(record: ChannelRecord): string[] {
  return normalizeAllowFrom(record.groupAllowFrom);
}

function readDmAllowFrom(params: {
  channelName: string;
  account: ChannelRecord;
  parent?: ChannelRecord;
}): string[] {
  return normalizeAllowFrom(
    resolveChannelDmAllowFrom({
      account: params.account,
      parent: params.parent,
      mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode,
    }),
  );
}

function readOwnDmAllowFrom(params: { channelName: string; account: ChannelRecord }): string[] {
  return normalizeAllowFrom(
    resolveChannelDmAllowFrom({
      account: params.account,
      mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode,
    }),
  );
}

function migrateRecord(params: {
  account: ChannelRecord;
  channelName: string;
  changes: string[];
  parent?: ChannelRecord;
  parentHadGroupAllowFrom?: boolean;
  prefix: string;
}): boolean {
  if (readGroupAllowFrom(params.account).length > 0) {
    return false;
  }
  if (params.parent && params.parentHadGroupAllowFrom) {
    return false;
  }
  const ownAllowFrom = readOwnDmAllowFrom(params);
  if (params.parent && ownAllowFrom.length === 0 && readGroupAllowFrom(params.parent).length > 0) {
    return false;
  }
  const allowFrom = readDmAllowFrom(params);
  if (allowFrom.length === 0) {
    return false;
  }
  params.account.groupAllowFrom = allowFrom;
  const noun = allowFrom.length === 1 ? "entry" : "entries";
  params.changes.push(
    `${params.prefix}.groupAllowFrom: copied ${allowFrom.length} sender ${noun} from allowFrom for explicit group allowlist.`,
  );
  return true;
}

export function maybeRepairGroupAllowFromFallback(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextChannels = next.channels as Record<string, ChannelRecord>;
  const changes: string[] = [];

  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (
      PSEUDO_CHANNEL_KEYS.has(channelName) ||
      !channelConfig ||
      typeof channelConfig !== "object"
    ) {
      continue;
    }
    if (isDisabled(channelConfig)) {
      continue;
    }
    if (!getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom) {
      continue;
    }

    const hadGroupAllowFrom = readGroupAllowFrom(channelConfig).length > 0;
    migrateRecord({
      account: channelConfig,
      channelName,
      changes,
      prefix: `channels.${channelName}`,
    });

    const accounts = asObjectRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountId, accountConfig] of Object.entries(accounts)) {
      const account = asObjectRecord(accountConfig);
      if (!account || isDisabled(account)) {
        continue;
      }
      migrateRecord({
        account,
        channelName,
        changes,
        parent: channelConfig,
        parentHadGroupAllowFrom: hadGroupAllowFrom,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

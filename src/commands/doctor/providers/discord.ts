import type { OpenClawConfig } from "../../../config/config.js";
import { asObjectRecord } from "../shared/object.js";
import type { DoctorAccountRecord } from "../types.js";

type DiscordNumericIdHit = { path: string; entry: number };

type DiscordIdListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: string;
};

export function collectDiscordAccountScopes(
  cfg: OpenClawConfig,
): Array<{ prefix: string; account: DoctorAccountRecord }> {
  const scopes: Array<{ prefix: string; account: DoctorAccountRecord }> = [];
  const discord = asObjectRecord(cfg.channels?.discord);
  if (!discord) {
    return scopes;
  }

  scopes.push({ prefix: "channels.discord", account: discord });
  const accounts = asObjectRecord(discord.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (!account) {
      continue;
    }
    scopes.push({ prefix: `channels.discord.accounts.${key}`, account });
  }

  return scopes;
}

export function collectDiscordIdLists(
  prefix: string,
  account: DoctorAccountRecord,
): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [
    { pathLabel: `${prefix}.allowFrom`, holder: account, key: "allowFrom" },
  ];
  const dm = asObjectRecord(account.dm);
  if (dm) {
    refs.push({ pathLabel: `${prefix}.dm.allowFrom`, holder: dm, key: "allowFrom" });
    refs.push({ pathLabel: `${prefix}.dm.groupChannels`, holder: dm, key: "groupChannels" });
  }
  const execApprovals = asObjectRecord(account.execApprovals);
  if (execApprovals) {
    refs.push({
      pathLabel: `${prefix}.execApprovals.approvers`,
      holder: execApprovals,
      key: "approvers",
    });
  }
  const guilds = asObjectRecord(account.guilds);
  if (!guilds) {
    return refs;
  }

  for (const guildId of Object.keys(guilds)) {
    const guild = asObjectRecord(guilds[guildId]);
    if (!guild) {
      continue;
    }
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.users`, holder: guild, key: "users" });
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.roles`, holder: guild, key: "roles" });
    const channels = asObjectRecord(guild.channels);
    if (!channels) {
      continue;
    }
    for (const channelId of Object.keys(channels)) {
      const channel = asObjectRecord(channels[channelId]);
      if (!channel) {
        continue;
      }
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.users`,
        holder: channel,
        key: "users",
      });
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.roles`,
        holder: channel,
        key: "roles",
      });
    }
  }
  return refs;
}

export function scanDiscordNumericIdEntries(cfg: OpenClawConfig): DiscordNumericIdHit[] {
  const hits: DiscordNumericIdHit[] = [];
  const scanList = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== "number") {
        continue;
      }
      hits.push({ path: `${pathLabel}[${index}]`, entry });
    }
  };

  for (const scope of collectDiscordAccountScopes(cfg)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }

  return hits;
}

export function maybeRepairDiscordNumericIds(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanDiscordNumericIdEntries(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const repairList = (pathLabel: string, holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!Array.isArray(raw)) {
      return;
    }
    let converted = 0;
    const updated = raw.map((entry) => {
      if (typeof entry === "number") {
        converted += 1;
        return String(entry);
      }
      return entry;
    });
    if (converted === 0) {
      return;
    }
    holder[key] = updated;
    changes.push(
      `- ${pathLabel}: converted ${converted} numeric ${converted === 1 ? "entry" : "entries"} to strings`,
    );
  };

  for (const scope of collectDiscordAccountScopes(next)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

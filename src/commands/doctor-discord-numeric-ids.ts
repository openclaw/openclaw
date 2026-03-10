import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";

type DiscordNumericIdHit = { path: string; entry: number };

type DiscordIdListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: string;
};

function collectDiscordAccountScopes(
  cfg: OpenClawConfig,
): Array<{ prefix: string; account: Record<string, unknown> }> {
  const scopes: Array<{ prefix: string; account: Record<string, unknown> }> = [];
  const discord = isRecord(cfg.channels?.discord) ? cfg.channels.discord : null;
  if (!discord) {
    return scopes;
  }

  scopes.push({ prefix: "channels.discord", account: discord });
  const accounts = isRecord(discord.accounts) ? discord.accounts : null;
  if (!accounts) {
    return scopes;
  }
  for (const [key, rawAccount] of Object.entries(accounts)) {
    if (!isRecord(rawAccount)) {
      continue;
    }
    scopes.push({ prefix: `channels.discord.accounts.${key}`, account: rawAccount });
  }

  return scopes;
}

function collectDiscordIdLists(
  prefix: string,
  account: Record<string, unknown>,
): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [
    { pathLabel: `${prefix}.allowFrom`, holder: account, key: "allowFrom" },
  ];
  const dm = isRecord(account.dm) ? account.dm : null;
  if (dm) {
    refs.push({ pathLabel: `${prefix}.dm.allowFrom`, holder: dm, key: "allowFrom" });
    refs.push({ pathLabel: `${prefix}.dm.groupChannels`, holder: dm, key: "groupChannels" });
  }
  const execApprovals = isRecord(account.execApprovals) ? account.execApprovals : null;
  if (execApprovals) {
    refs.push({
      pathLabel: `${prefix}.execApprovals.approvers`,
      holder: execApprovals,
      key: "approvers",
    });
  }
  const guilds = isRecord(account.guilds) ? account.guilds : null;
  if (!guilds) {
    return refs;
  }

  for (const [guildId, rawGuild] of Object.entries(guilds)) {
    if (!isRecord(rawGuild)) {
      continue;
    }
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.users`, holder: rawGuild, key: "users" });
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.roles`, holder: rawGuild, key: "roles" });
    const channels = isRecord(rawGuild.channels) ? rawGuild.channels : null;
    if (!channels) {
      continue;
    }
    for (const [channelId, rawChannel] of Object.entries(channels)) {
      if (!isRecord(rawChannel)) {
        continue;
      }
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.users`,
        holder: rawChannel,
        key: "users",
      });
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.roles`,
        holder: rawChannel,
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

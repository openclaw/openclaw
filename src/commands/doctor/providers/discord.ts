import type { OpenClawConfig } from "../../../config/config.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "../shared/object.js";
import type { DoctorAccountRecord } from "../types.js";

type DiscordNumericIdHit = { path: string; entry: number; safe: boolean };

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
      hits.push({
        path: `${pathLabel}[${index}]`,
        entry,
        safe: Number.isSafeInteger(entry) && entry >= 0,
      });
    }
  };

  for (const scope of collectDiscordAccountScopes(cfg)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }

  return hits;
}

export function collectDiscordNumericIdWarnings(params: {
  hits: DiscordNumericIdHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const lines: string[] = [];
  const hitsByListPath = new Map<string, DiscordNumericIdHit[]>();
  for (const hit of params.hits) {
    const listPath = hit.path.replace(/\[\d+\]$/, "");
    const existing = hitsByListPath.get(listPath);
    if (existing) {
      existing.push(hit);
      continue;
    }
    hitsByListPath.set(listPath, [hit]);
  }

  const repairableHits: DiscordNumericIdHit[] = [];
  const blockedHits: DiscordNumericIdHit[] = [];
  for (const hits of hitsByListPath.values()) {
    if (hits.some((hit) => !hit.safe)) {
      blockedHits.push(...hits);
      continue;
    }
    repairableHits.push(...hits);
  }

  if (repairableHits.length > 0) {
    const sample = repairableHits[0];
    const samplePath = sanitizeForLog(sample.path);
    const sampleEntry = sanitizeForLog(String(sample.entry));
    lines.push(
      `- Discord allowlists contain ${repairableHits.length} numeric ${repairableHits.length === 1 ? "entry" : "entries"} (e.g. ${samplePath}=${sampleEntry}).`,
      `- Discord IDs must be strings; run "${params.doctorFixCommand}" to convert numeric IDs to quoted strings.`,
    );
  }
  if (blockedHits.length > 0) {
    const sample = blockedHits[0];
    const samplePath = sanitizeForLog(sample.path);
    lines.push(
      `- Discord allowlists contain ${blockedHits.length} numeric ${blockedHits.length === 1 ? "entry" : "entries"} in lists that cannot be auto-repaired (e.g. ${samplePath}).`,
      `- These lists include invalid or precision-losing numeric IDs; manually quote the original values in your config file, then rerun "${params.doctorFixCommand}".`,
    );
  }
  return lines;
}

function collectBlockedDiscordNumericIdRepairWarnings(params: {
  hits: DiscordNumericIdHit[];
  doctorFixCommand: string;
}): string[] {
  const hitsByListPath = new Map<string, DiscordNumericIdHit[]>();
  for (const hit of params.hits) {
    const listPath = hit.path.replace(/\[\d+\]$/, "");
    const existing = hitsByListPath.get(listPath);
    if (existing) {
      existing.push(hit);
      continue;
    }
    hitsByListPath.set(listPath, [hit]);
  }

  const blockedHits: DiscordNumericIdHit[] = [];
  for (const hits of hitsByListPath.values()) {
    if (hits.some((hit) => !hit.safe)) {
      blockedHits.push(...hits);
    }
  }
  if (blockedHits.length === 0) {
    return [];
  }

  const sample = blockedHits[0];
  const samplePath = sanitizeForLog(sample.path);
  return [
    `- Discord allowlists contain ${blockedHits.length} numeric ${blockedHits.length === 1 ? "entry" : "entries"} in lists that could not be auto-repaired (e.g. ${samplePath}).`,
    `- These lists include invalid or precision-losing numeric IDs; manually quote the original values in your config file, then rerun "${params.doctorFixCommand}".`,
  ];
}

export function maybeRepairDiscordNumericIds(
  cfg: OpenClawConfig,
  params?: { doctorFixCommand?: string },
): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
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
    const hasUnsafe = raw.some(
      (entry) => typeof entry === "number" && (!Number.isSafeInteger(entry) || entry < 0),
    );
    if (hasUnsafe) {
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

  const warnings =
    params?.doctorFixCommand === undefined
      ? []
      : collectBlockedDiscordNumericIdRepairWarnings({
          hits,
          doctorFixCommand: params.doctorFixCommand,
        });

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes, warnings };
}

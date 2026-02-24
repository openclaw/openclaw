import fs from "node:fs/promises";
import path from "node:path";
import type { ZodIssue } from "zod";
import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../channels/telegram/allow-from.js";
import { fetchTelegramChatId } from "../channels/telegram/api.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  OpenClawSchema,
  CONFIG_PATH,
  migrateLegacyConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { parseToolsBySenderTypedKey } from "../config/types.tools.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../infra/exec-safe-bin-runtime-policy.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "../telegram/accounts.js";
import { note } from "../terminal/note.js";
import { isRecord, resolveHomeDir } from "../utils.js";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { autoMigrateLegacyStateDir } from "./doctor-state-migrations.js";

type UnrecognizedKeysIssue = ZodIssue & {
  code: "unrecognized_keys";
  keys: PropertyKey[];
};

function normalizeIssuePath(path: PropertyKey[]): Array<string | number> {
  return path.filter((part): part is string | number => typeof part !== "symbol");
}

function isUnrecognizedKeysIssue(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

function formatPath(parts: Array<string | number>): string {
  if (parts.length === 0) {
    return "<root>";
  }
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") {
      out += `[${part}]`;
      continue;
    }
    out = out ? `${out}.${part}` : part;
  }
  return out || "<root>";
}

function resolvePathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (part < 0 || part >= current.length) {
        return null;
      }
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!(part in record)) {
      return null;
    }
    current = record[part];
  }
  return current;
}

function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
} {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) {
      continue;
    }
    const path = normalizeIssuePath(issue.path);
    const target = resolvePathTarget(next, path);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      if (typeof key !== "string") {
        continue;
      }
      if (!(key in record)) {
        continue;
      }
      delete record[key];
      removed.push(formatPath([...path, key]));
    }
  }

  return { config: next, removed };
}

function noteOpencodeProviderOverrides(cfg: OpenClawConfig) {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) {
    overrides.push("opencode");
  }
  if (providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (overrides.length === 0) {
    return;
  }

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

function noteIncludeConfinementWarning(snapshot: {
  path?: string | null;
  issues?: Array<{ message: string }>;
}): void {
  const issues = snapshot.issues ?? [];
  const includeIssue = issues.find(
    (issue) =>
      issue.message.includes("Include path escapes config directory") ||
      issue.message.includes("Include path resolves outside config directory"),
  );
  if (!includeIssue) {
    return;
  }
  const configRoot = path.dirname(snapshot.path ?? CONFIG_PATH);
  note(
    [
      `- $include paths must stay under: ${configRoot}`,
      '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
      `- Error: ${includeIssue.message}`,
    ].join("\n"),
    "Doctor warnings",
  );
}

type TelegramAllowFromUsernameHit = { path: string; entry: string };

type TelegramAllowFromListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: "allowFrom" | "groupAllowFrom";
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function collectTelegramAccountScopes(
  cfg: OpenClawConfig,
): Array<{ prefix: string; account: Record<string, unknown> }> {
  const scopes: Array<{ prefix: string; account: Record<string, unknown> }> = [];
  const telegram = asObjectRecord(cfg.channels?.telegram);
  if (!telegram) {
    return scopes;
  }

  scopes.push({ prefix: "channels.telegram", account: telegram });
  const accounts = asObjectRecord(telegram.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (!account) {
      continue;
    }
    scopes.push({ prefix: `channels.telegram.accounts.${key}`, account });
  }

  return scopes;
}

function collectTelegramAllowFromLists(
  prefix: string,
  account: Record<string, unknown>,
): TelegramAllowFromListRef[] {
  const refs: TelegramAllowFromListRef[] = [
    { pathLabel: `${prefix}.allowFrom`, holder: account, key: "allowFrom" },
    { pathLabel: `${prefix}.groupAllowFrom`, holder: account, key: "groupAllowFrom" },
  ];
  const groups = asObjectRecord(account.groups);
  if (!groups) {
    return refs;
  }

  for (const groupId of Object.keys(groups)) {
    const group = asObjectRecord(groups[groupId]);
    if (!group) {
      continue;
    }
    refs.push({
      pathLabel: `${prefix}.groups.${groupId}.allowFrom`,
      holder: group,
      key: "allowFrom",
    });
    const topics = asObjectRecord(group.topics);
    if (!topics) {
      continue;
    }
    for (const topicId of Object.keys(topics)) {
      const topic = asObjectRecord(topics[topicId]);
      if (!topic) {
        continue;
      }
      refs.push({
        pathLabel: `${prefix}.groups.${groupId}.topics.${topicId}.allowFrom`,
        holder: topic,
        key: "allowFrom",
      });
    }
  }
  return refs;
}

function scanTelegramAllowFromUsernameEntries(cfg: OpenClawConfig): TelegramAllowFromUsernameHit[] {
  const hits: TelegramAllowFromUsernameHit[] = [];

  const scanList = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const normalized = normalizeTelegramAllowFromEntry(entry);
      if (!normalized || normalized === "*") {
        continue;
      }
      if (isNumericTelegramUserId(normalized)) {
        continue;
      }
      hits.push({ path: pathLabel, entry: String(entry).trim() });
    }
  };

  for (const scope of collectTelegramAccountScopes(cfg)) {
    for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }

  return hits;
}

async function maybeRepairTelegramAllowFromUsernames(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const hits = scanTelegramAllowFromUsernameEntries(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const tokens = Array.from(
    new Set(
      listTelegramAccountIds(cfg)
        .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
        .map((account) => (account.tokenSource === "none" ? "" : account.token))
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  );

  if (tokens.length === 0) {
    return {
      config: cfg,
      changes: [
        `- Telegram allowFrom contains @username entries, but no Telegram bot token is configured; cannot auto-resolve (run onboarding or replace with numeric sender IDs).`,
      ],
    };
  }

  const resolveUserId = async (raw: string): Promise<string | null> => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const stripped = normalizeTelegramAllowFromEntry(trimmed);
    if (!stripped || stripped === "*") {
      return null;
    }
    if (isNumericTelegramUserId(stripped)) {
      return stripped;
    }
    if (/\s/.test(stripped)) {
      return null;
    }
    const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
    for (const token of tokens) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const id = await fetchTelegramChatId({
          token,
          chatId: username,
          signal: controller.signal,
        });
        if (id) {
          return id;
        }
      } catch {
        // ignore and try next token
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  };

  const changes: string[] = [];
  const next = structuredClone(cfg);

  const repairList = async (pathLabel: string, holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!Array.isArray(raw)) {
      return;
    }
    const out: Array<string | number> = [];
    const replaced: Array<{ from: string; to: string }> = [];
    for (const entry of raw) {
      const normalized = normalizeTelegramAllowFromEntry(entry);
      if (!normalized) {
        continue;
      }
      if (normalized === "*") {
        out.push("*");
        continue;
      }
      if (isNumericTelegramUserId(normalized)) {
        out.push(normalized);
        continue;
      }
      const resolved = await resolveUserId(String(entry));
      if (resolved) {
        out.push(resolved);
        replaced.push({ from: String(entry).trim(), to: resolved });
      } else {
        out.push(String(entry).trim());
      }
    }
    const deduped: Array<string | number> = [];
    const seen = new Set<string>();
    for (const entry of out) {
      const k = String(entry).trim();
      if (!k || seen.has(k)) {
        continue;
      }
      seen.add(k);
      deduped.push(entry);
    }
    holder[key] = deduped;
    if (replaced.length > 0) {
      for (const rep of replaced.slice(0, 5)) {
        changes.push(`- ${pathLabel}: resolved ${rep.from} -> ${rep.to}`);
      }
      if (replaced.length > 5) {
        changes.push(`- ${pathLabel}: resolved ${replaced.length - 5} more @username entries`);
      }
    }
  };

  const repairAccount = async (prefix: string, account: Record<string, unknown>) => {
    for (const ref of collectTelegramAllowFromLists(prefix, account)) {
      await repairList(ref.pathLabel, ref.holder, ref.key);
    }
  };

  for (const scope of collectTelegramAccountScopes(next)) {
    await repairAccount(scope.prefix, scope.account);
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

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

function collectDiscordIdLists(
  prefix: string,
  account: Record<string, unknown>,
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

function scanDiscordNumericIdEntries(cfg: OpenClawConfig): DiscordNumericIdHit[] {
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

function maybeRepairDiscordNumericIds(cfg: OpenClawConfig): {
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

type MutableAllowlistHit = {
  channel: string;
  path: string;
  entry: string;
  dangerousFlagPath: string;
};

type ProviderAccountScope = {
  prefix: string;
  account: Record<string, unknown>;
  dangerousNameMatchingEnabled: boolean;
  dangerousFlagPath: string;
};

function collectProviderAccountScopes(
  cfg: OpenClawConfig,
  provider: string,
): ProviderAccountScope[] {
  const scopes: ProviderAccountScope[] = [];
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return scopes;
  }
  const providerCfg = asObjectRecord(channels[provider]);
  if (!providerCfg) {
    return scopes;
  }
  const providerPrefix = `channels.${provider}`;
  const providerDangerousFlagPath = `${providerPrefix}.dangerouslyAllowNameMatching`;
  const providerDangerousNameMatchingEnabled = providerCfg.dangerouslyAllowNameMatching === true;
  scopes.push({
    prefix: providerPrefix,
    account: providerCfg,
    dangerousNameMatchingEnabled: providerDangerousNameMatchingEnabled,
    dangerousFlagPath: providerDangerousFlagPath,
  });
  const accounts = asObjectRecord(providerCfg.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (!account) {
      continue;
    }
    const accountPrefix = `${providerPrefix}.accounts.${key}`;
    const accountDangerousNameMatching = asOptionalBoolean(account.dangerouslyAllowNameMatching);
    scopes.push({
      prefix: accountPrefix,
      account,
      dangerousNameMatchingEnabled:
        accountDangerousNameMatching ?? providerDangerousNameMatchingEnabled,
      dangerousFlagPath:
        accountDangerousNameMatching == null
          ? providerDangerousFlagPath
          : `${accountPrefix}.dangerouslyAllowNameMatching`,
    });
  }
  return scopes;
}

function isDiscordMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeMentionId)) {
    return false;
  }
  for (const prefix of ["discord:", "user:", "pk:"]) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    return text.slice(prefix.length).trim().length === 0;
  }
  return true;
}

function isSlackMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const mentionMatch = text.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch && /^[A-Z0-9]{8,}$/i.test(mentionMatch[1] ?? "")) {
    return false;
  }
  const withoutPrefix = text.replace(/^(slack|user):/i, "").trim();
  if (/^[UWBCGDT][A-Z0-9]{2,}$/.test(withoutPrefix)) {
    return false;
  }
  if (/^[A-Z0-9]{8,}$/i.test(withoutPrefix)) {
    return false;
  }
  return true;
}

function isGoogleChatMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const withoutPrefix = text.replace(/^(googlechat|google-chat|gchat):/i, "").trim();
  if (!withoutPrefix) {
    return false;
  }
  const withoutUsers = withoutPrefix.replace(/^users\//i, "");
  return withoutUsers.includes("@");
}

function isMSTeamsMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const withoutPrefix = text.replace(/^(msteams|user):/i, "").trim();
  return /\s/.test(withoutPrefix) || withoutPrefix.includes("@");
}

function isMattermostMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const normalized = text
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  // Mattermost user IDs are stable 26-char lowercase/number tokens.
  if (/^[a-z0-9]{26}$/.test(normalized)) {
    return false;
  }
  return true;
}

function isIrcMutableAllowEntry(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text || text === "*") {
    return false;
  }
  const normalized = text
    .replace(/^irc:/, "")
    .replace(/^user:/, "")
    .trim();
  return !normalized.includes("!") && !normalized.includes("@");
}

function addMutableAllowlistHits(params: {
  hits: MutableAllowlistHit[];
  pathLabel: string;
  list: unknown;
  detector: (entry: string) => boolean;
  channel: string;
  dangerousFlagPath: string;
}) {
  if (!Array.isArray(params.list)) {
    return;
  }
  for (const entry of params.list) {
    const text = String(entry).trim();
    if (!text || text === "*") {
      continue;
    }
    if (!params.detector(text)) {
      continue;
    }
    params.hits.push({
      channel: params.channel,
      path: params.pathLabel,
      entry: text,
      dangerousFlagPath: params.dangerousFlagPath,
    });
  }
}

function scanMutableAllowlistEntries(cfg: OpenClawConfig): MutableAllowlistHit[] {
  const hits: MutableAllowlistHit[] = [];

  for (const scope of collectProviderAccountScopes(cfg, "discord")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isDiscordMutableAllowEntry,
      channel: "discord",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isDiscordMutableAllowEntry,
        channel: "discord",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const guilds = asObjectRecord(scope.account.guilds);
    if (!guilds) {
      continue;
    }
    for (const [guildId, guildRaw] of Object.entries(guilds)) {
      const guild = asObjectRecord(guildRaw);
      if (!guild) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.guilds.${guildId}.users`,
        list: guild.users,
        detector: isDiscordMutableAllowEntry,
        channel: "discord",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
      const channels = asObjectRecord(guild.channels);
      if (!channels) {
        continue;
      }
      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = asObjectRecord(channelRaw);
        if (!channel) {
          continue;
        }
        addMutableAllowlistHits({
          hits,
          pathLabel: `${scope.prefix}.guilds.${guildId}.channels.${channelId}.users`,
          list: channel.users,
          detector: isDiscordMutableAllowEntry,
          channel: "discord",
          dangerousFlagPath: scope.dangerousFlagPath,
        });
      }
    }
  }

  for (const scope of collectProviderAccountScopes(cfg, "slack")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isSlackMutableAllowEntry,
      channel: "slack",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isSlackMutableAllowEntry,
        channel: "slack",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const channels = asObjectRecord(scope.account.channels);
    if (!channels) {
      continue;
    }
    for (const [channelKey, channelRaw] of Object.entries(channels)) {
      const channel = asObjectRecord(channelRaw);
      if (!channel) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
        list: channel.users,
        detector: isSlackMutableAllowEntry,
        channel: "slack",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  for (const scope of collectProviderAccountScopes(cfg, "googlechat")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isGoogleChatMutableAllowEntry,
      channel: "googlechat",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isGoogleChatMutableAllowEntry,
        channel: "googlechat",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const [groupKey, groupRaw] of Object.entries(groups)) {
      const group = asObjectRecord(groupRaw);
      if (!group) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.groups.${groupKey}.users`,
        list: group.users,
        detector: isGoogleChatMutableAllowEntry,
        channel: "googlechat",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  for (const scope of collectProviderAccountScopes(cfg, "msteams")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isMSTeamsMutableAllowEntry,
      channel: "msteams",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isMSTeamsMutableAllowEntry,
      channel: "msteams",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
  }

  for (const scope of collectProviderAccountScopes(cfg, "mattermost")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isMattermostMutableAllowEntry,
      channel: "mattermost",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isMattermostMutableAllowEntry,
      channel: "mattermost",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
  }

  for (const scope of collectProviderAccountScopes(cfg, "irc")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isIrcMutableAllowEntry,
      channel: "irc",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isIrcMutableAllowEntry,
      channel: "irc",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const [groupKey, groupRaw] of Object.entries(groups)) {
      const group = asObjectRecord(groupRaw);
      if (!group) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
        list: group.allowFrom,
        detector: isIrcMutableAllowEntry,
        channel: "irc",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  return hits;
}

/**
 * Scan all channel configs for dmPolicy="open" without allowFrom including "*".
 * This configuration is rejected by the schema validator but can easily occur when
 * users (or integrations) set dmPolicy to "open" without realising that an explicit
 * allowFrom wildcard is also required.
 */
function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  type OpenPolicyAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

  const resolveAllowFromMode = (channelName: string): OpenPolicyAllowFromMode => {
    if (channelName === "googlechat") {
      return "nestedOnly";
    }
    if (channelName === "discord" || channelName === "slack") {
      return "topOrNested";
    }
    return "topOnly";
  };

  const hasWildcard = (list?: Array<string | number>) =>
    list?.some((v) => String(v).trim() === "*") ?? false;

  const ensureWildcard = (
    account: Record<string, unknown>,
    prefix: string,
    mode: OpenPolicyAllowFromMode,
  ) => {
    const dmEntry = account.dm;
    const dm =
      dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
        ? (dmEntry as Record<string, unknown>)
        : undefined;
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
  };

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }

    const allowFromMode = resolveAllowFromMode(channelName);

    // Check the top-level channel config
    ensureWildcard(channelConfig, `channels.${channelName}`, allowFromMode);

    // Check per-account configs (e.g. channels.discord.accounts.mybot)
    const accounts = channelConfig.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && typeof accounts === "object") {
      for (const [accountName, accountConfig] of Object.entries(accounts)) {
        if (accountConfig && typeof accountConfig === "object") {
          ensureWildcard(
            accountConfig,
            `channels.${channelName}.accounts.${accountName}`,
            allowFromMode,
          );
        }
      }
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

type ExecSafeBinCoverageHit = {
  scopePath: string;
  bin: string;
  isInterpreter: boolean;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, unknown>;
};

function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ).toSorted();
}

function collectExecSafeBinScopes(cfg: OpenClawConfig): ExecSafeBinScopeRef[] {
  const scopes: ExecSafeBinScopeRef[] = [];
  const globalExec = asObjectRecord(cfg.tools?.exec);
  if (globalExec) {
    const safeBins = normalizeConfiguredSafeBins(globalExec.safeBins);
    if (safeBins.length > 0) {
      scopes.push({
        scopePath: "tools.exec",
        safeBins,
        exec: globalExec,
        mergedProfiles:
          resolveMergedSafeBinProfileFixtures({
            global: globalExec,
          }) ?? {},
      });
    }
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    const agentExec = asObjectRecord(agent.tools?.exec);
    if (!agentExec) {
      continue;
    }
    const safeBins = normalizeConfiguredSafeBins(agentExec.safeBins);
    if (safeBins.length === 0) {
      continue;
    }
    scopes.push({
      scopePath: `agents.list.${agent.id}.tools.exec`,
      safeBins,
      exec: agentExec,
      mergedProfiles:
        resolveMergedSafeBinProfileFixtures({
          global: globalExec,
          local: agentExec,
        }) ?? {},
    });
  }
  return scopes;
}

function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        isInterpreter: interpreterBins.has(bin),
      });
    }
  }
  return hits;
}

function maybeRepairExecSafeBinProfiles(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const next = structuredClone(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];

  for (const scope of collectExecSafeBinScopes(next)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    const missingBins = scope.safeBins.filter((bin) => !scope.mergedProfiles[bin]);
    if (missingBins.length === 0) {
      continue;
    }
    const profileHolder =
      asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
    for (const bin of missingBins) {
      if (interpreterBins.has(bin)) {
        warnings.push(
          `- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`,
        );
        continue;
      }
      if (profileHolder[bin] !== undefined) {
        continue;
      }
      profileHolder[bin] = {};
      changes.push(
        `- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile {} (review and tighten flags/positionals).`,
      );
    }
  }

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [], warnings: [] };
  }
  return { config: next, changes, warnings };
}

type LegacyToolsBySenderKeyHit = {
  toolsBySenderPath: Array<string | number>;
  pathLabel: string;
  key: string;
  targetKey: string;
};

function collectLegacyToolsBySenderKeyHits(
  value: unknown,
  pathParts: Array<string | number>,
  hits: LegacyToolsBySenderKeyHit[],
) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectLegacyToolsBySenderKeyHits(entry, [...pathParts, index], hits);
    }
    return;
  }
  const record = asObjectRecord(value);
  if (!record) {
    return;
  }

  const toolsBySender = asObjectRecord(record.toolsBySender);
  if (toolsBySender) {
    const path = [...pathParts, "toolsBySender"];
    const pathLabel = formatPath(path);
    for (const rawKey of Object.keys(toolsBySender)) {
      const trimmed = rawKey.trim();
      if (!trimmed || trimmed === "*" || parseToolsBySenderTypedKey(trimmed)) {
        continue;
      }
      hits.push({
        toolsBySenderPath: path,
        pathLabel,
        key: rawKey,
        targetKey: `id:${trimmed}`,
      });
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "toolsBySender") {
      continue;
    }
    collectLegacyToolsBySenderKeyHits(nested, [...pathParts, key], hits);
  }
}

function scanLegacyToolsBySenderKeys(cfg: OpenClawConfig): LegacyToolsBySenderKeyHit[] {
  const hits: LegacyToolsBySenderKeyHit[] = [];
  collectLegacyToolsBySenderKeyHits(cfg, [], hits);
  return hits;
}

function maybeRepairLegacyToolsBySenderKeys(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(cfg);
  const hits = scanLegacyToolsBySenderKeys(next);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const summary = new Map<string, { migrated: number; dropped: number; examples: string[] }>();
  let changed = false;

  for (const hit of hits) {
    const toolsBySender = asObjectRecord(resolvePathTarget(next, hit.toolsBySenderPath));
    if (!toolsBySender || !(hit.key in toolsBySender)) {
      continue;
    }
    const row = summary.get(hit.pathLabel) ?? { migrated: 0, dropped: 0, examples: [] };

    if (toolsBySender[hit.targetKey] === undefined) {
      toolsBySender[hit.targetKey] = toolsBySender[hit.key];
      row.migrated++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} -> ${hit.targetKey}`);
      }
    } else {
      row.dropped++;
      if (row.examples.length < 3) {
        row.examples.push(`${hit.key} (kept existing ${hit.targetKey})`);
      }
    }
    delete toolsBySender[hit.key];
    summary.set(hit.pathLabel, row);
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  for (const [pathLabel, row] of summary) {
    if (row.migrated > 0) {
      const suffix = row.examples.length > 0 ? ` (${row.examples.join(", ")})` : "";
      changes.push(
        `- ${pathLabel}: migrated ${row.migrated} legacy key${row.migrated === 1 ? "" : "s"} to typed id: entries${suffix}.`,
      );
    }
    if (row.dropped > 0) {
      changes.push(
        `- ${pathLabel}: removed ${row.dropped} legacy key${row.dropped === 1 ? "" : "s"} where typed id: entries already existed.`,
      );
    }
  }

  return { config: next, changes };
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [
    path.join(home, ".clawdbot", "clawdbot.json"),
    path.join(home, ".moldbot", "moldbot.json"),
    path.join(home, ".moltbot", "moltbot.json"),
  ];

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
  if (stateDirResult.changes.length > 0) {
    note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  if (stateDirResult.warnings.length > 0) {
    note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }

  const legacyConfigChanges = await maybeMigrateLegacyConfig();
  if (legacyConfigChanges.length > 0) {
    note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }

  let snapshot = await readConfigFileSnapshot();
  const baseCfg = snapshot.config ?? {};
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let shouldWriteConfig = false;
  const fixHints: string[] = [];
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
    note("Config invalid; doctor will run with best-effort config.", "Config");
    noteIncludeConfinementWarning(snapshot);
  }
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    const lines = warnings.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    note(lines, "Config warnings");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
      "Legacy config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) {
        cfg = migrated;
      }
    } else {
      fixHints.push(
        `Run "${formatCliCommand("openclaw doctor --fix")}" to apply legacy migrations.`,
      );
    }
  }

  const normalized = normalizeLegacyConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    candidate = normalized.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = normalized.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    candidate = autoEnable.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = autoEnable.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  if (shouldRepair) {
    const repair = await maybeRepairTelegramAllowFromUsernames(candidate);
    if (repair.changes.length > 0) {
      note(repair.changes.join("\n"), "Doctor changes");
      candidate = repair.config;
      pendingChanges = true;
      cfg = repair.config;
    }

    const discordRepair = maybeRepairDiscordNumericIds(candidate);
    if (discordRepair.changes.length > 0) {
      note(discordRepair.changes.join("\n"), "Doctor changes");
      candidate = discordRepair.config;
      pendingChanges = true;
      cfg = discordRepair.config;
    }

    const allowFromRepair = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromRepair.changes.length > 0) {
      note(allowFromRepair.changes.join("\n"), "Doctor changes");
      candidate = allowFromRepair.config;
      pendingChanges = true;
      cfg = allowFromRepair.config;
    }

    const toolsBySenderRepair = maybeRepairLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderRepair.changes.length > 0) {
      note(toolsBySenderRepair.changes.join("\n"), "Doctor changes");
      candidate = toolsBySenderRepair.config;
      pendingChanges = true;
      cfg = toolsBySenderRepair.config;
    }

    const safeBinProfileRepair = maybeRepairExecSafeBinProfiles(candidate);
    if (safeBinProfileRepair.changes.length > 0) {
      note(safeBinProfileRepair.changes.join("\n"), "Doctor changes");
      candidate = safeBinProfileRepair.config;
      pendingChanges = true;
      cfg = safeBinProfileRepair.config;
    }
    if (safeBinProfileRepair.warnings.length > 0) {
      note(safeBinProfileRepair.warnings.join("\n"), "Doctor warnings");
    }
  } else {
    const hits = scanTelegramAllowFromUsernameEntries(candidate);
    if (hits.length > 0) {
      note(
        [
          `- Telegram allowFrom contains ${hits.length} non-numeric entries (e.g. ${hits[0]?.entry ?? "@"}); Telegram authorization requires numeric sender IDs.`,
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to auto-resolve @username entries to numeric IDs (requires a Telegram bot token).`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const discordHits = scanDiscordNumericIdEntries(candidate);
    if (discordHits.length > 0) {
      note(
        [
          `- Discord allowlists contain ${discordHits.length} numeric entries (e.g. ${discordHits[0]?.path}=${discordHits[0]?.entry}).`,
          `- Discord IDs must be strings; run "${formatCliCommand("openclaw doctor --fix")}" to convert numeric IDs to quoted strings.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const allowFromScan = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromScan.changes.length > 0) {
      note(
        [
          ...allowFromScan.changes,
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to add missing allowFrom wildcards.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const toolsBySenderHits = scanLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderHits.length > 0) {
      const sample = toolsBySenderHits[0];
      const sampleLabel = sample ? `${sample.pathLabel}.${sample.key}` : "toolsBySender";
      note(
        [
          `- Found ${toolsBySenderHits.length} legacy untyped toolsBySender key${toolsBySenderHits.length === 1 ? "" : "s"} (for example ${sampleLabel}).`,
          "- Untyped sender keys are deprecated; use explicit prefixes (id:, e164:, username:, name:).",
          `- Run "${formatCliCommand("openclaw doctor --fix")}" to migrate legacy keys to typed id: entries.`,
        ].join("\n"),
        "Doctor warnings",
      );
    }

    const safeBinCoverage = scanExecSafeBinCoverage(candidate);
    if (safeBinCoverage.length > 0) {
      const interpreterHits = safeBinCoverage.filter((hit) => hit.isInterpreter);
      const customHits = safeBinCoverage.filter((hit) => !hit.isInterpreter);
      const lines: string[] = [];
      if (interpreterHits.length > 0) {
        for (const hit of interpreterHits.slice(0, 5)) {
          lines.push(
            `- ${hit.scopePath}.safeBins includes interpreter/runtime '${hit.bin}' without profile.`,
          );
        }
        if (interpreterHits.length > 5) {
          lines.push(
            `- ${interpreterHits.length - 5} more interpreter/runtime safeBins entries are missing profiles.`,
          );
        }
      }
      if (customHits.length > 0) {
        for (const hit of customHits.slice(0, 5)) {
          lines.push(
            `- ${hit.scopePath}.safeBins entry '${hit.bin}' is missing safeBinProfiles.${hit.bin}.`,
          );
        }
        if (customHits.length > 5) {
          lines.push(
            `- ${customHits.length - 5} more custom safeBins entries are missing profiles.`,
          );
        }
      }
      lines.push(
        `- Run "${formatCliCommand("openclaw doctor --fix")}" to scaffold missing custom safeBinProfiles entries.`,
      );
      note(lines.join("\n"), "Doctor warnings");
    }
  }

  const mutableAllowlistHits = scanMutableAllowlistEntries(candidate);
  if (mutableAllowlistHits.length > 0) {
    const channels = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.channel))).toSorted();
    const exampleLines = mutableAllowlistHits
      .slice(0, 8)
      .map((hit) => `- ${hit.path}: ${hit.entry}`)
      .join("\n");
    const remaining =
      mutableAllowlistHits.length > 8
        ? `- +${mutableAllowlistHits.length - 8} more mutable allowlist entries.`
        : null;
    const flagPaths = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.dangerousFlagPath)));
    const flagHint =
      flagPaths.length === 1
        ? flagPaths[0]
        : `${flagPaths[0]} (and ${flagPaths.length - 1} other scope flags)`;
    note(
      [
        `- Found ${mutableAllowlistHits.length} mutable allowlist ${mutableAllowlistHits.length === 1 ? "entry" : "entries"} across ${channels.join(", ")} while name matching is disabled by default.`,
        exampleLines,
        ...(remaining ? [remaining] : []),
        `- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
        "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
      ].join("\n"),
      "Doctor warnings",
    );
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
    candidate = unknown.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = unknown.config;
      note(lines, "Doctor changes");
    } else {
      note(lines, "Unknown config keys");
      fixHints.push('Run "openclaw doctor --fix" to remove these keys.');
    }
  }

  if (!shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  if (shouldRepair && pendingChanges) {
    shouldWriteConfig = true;
  }

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}

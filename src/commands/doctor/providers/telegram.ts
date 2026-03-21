import {
  inspectTelegramAccount,
  isNumericTelegramUserId,
  listTelegramAccountIds,
  lookupTelegramChatId,
  normalizeTelegramAllowFromEntry,
} from "../../../../extensions/telegram/api.js";
import { resolveCommandSecretRefsViaGateway } from "../../../cli/command-secret-gateway.js";
import { getChannelsCommandSecretTargetIds } from "../../../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { TelegramNetworkConfig } from "../../../config/types.telegram.js";
import { resolveTelegramAccount } from "../../../plugin-sdk/account-resolution.js";
import { describeUnknownError } from "../../../secrets/shared.js";
import { hasAllowFromEntries } from "../shared/allowlist.js";
import { asObjectRecord } from "../shared/object.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";

type TelegramAllowFromUsernameHit = { path: string; entry: string };

type TelegramAllowFromListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: "allowFrom" | "groupAllowFrom";
};

type ResolvedTelegramLookupAccount = {
  token: string;
  apiRoot?: string;
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
};

export function collectTelegramAccountScopes(
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

export function collectTelegramAllowFromLists(
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

export function scanTelegramAllowFromUsernameEntries(
  cfg: OpenClawConfig,
): TelegramAllowFromUsernameHit[] {
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

export async function maybeRepairTelegramAllowFromUsernames(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const hits = scanTelegramAllowFromUsernameEntries(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: cfg,
    commandName: "doctor --fix",
    targetIds: getChannelsCommandSecretTargetIds(),
    mode: "read_only_status",
  });
  const hasConfiguredUnavailableToken = listTelegramAccountIds(cfg).some((accountId) => {
    const inspected = inspectTelegramAccount({ cfg, accountId });
    return inspected.enabled && inspected.tokenStatus === "configured_unavailable";
  });
  const tokenResolutionWarnings: string[] = [];
  const lookupAccounts: ResolvedTelegramLookupAccount[] = [];
  const seenLookupAccounts = new Set<string>();
  for (const accountId of listTelegramAccountIds(resolvedConfig)) {
    let account: NonNullable<ReturnType<typeof resolveTelegramAccount>>;
    try {
      account = resolveTelegramAccount({ cfg: resolvedConfig, accountId });
    } catch (error) {
      tokenResolutionWarnings.push(
        `- Telegram account ${accountId}: failed to inspect bot token (${describeUnknownError(error)}).`,
      );
      continue;
    }
    const token = account.tokenSource === "none" ? "" : account.token.trim();
    if (!token) {
      continue;
    }
    const apiRoot = account.config.apiRoot?.trim() || undefined;
    const proxyUrl = account.config.proxy?.trim() || undefined;
    const network = account.config.network;
    const cacheKey = `${token}::${apiRoot ?? ""}::${proxyUrl ?? ""}::${JSON.stringify(network ?? {})}`;
    if (seenLookupAccounts.has(cacheKey)) {
      continue;
    }
    seenLookupAccounts.add(cacheKey);
    lookupAccounts.push({ token, apiRoot, proxyUrl, network });
  }

  if (lookupAccounts.length === 0) {
    return {
      config: cfg,
      changes: [
        ...tokenResolutionWarnings,
        hasConfiguredUnavailableToken
          ? `- Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path; cannot auto-resolve (start the gateway or make the secret source available, then rerun doctor --fix).`
          : `- Telegram allowFrom contains @username entries, but no Telegram bot token is configured; cannot auto-resolve (run setup or replace with numeric sender IDs).`,
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
    for (const account of lookupAccounts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const id = await lookupTelegramChatId({
          token: account.token,
          chatId: username,
          signal: controller.signal,
          apiRoot: account.apiRoot,
          proxyUrl: account.proxyUrl,
          network: account.network,
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
    const out: DoctorAllowFromList = [];
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
    const deduped: DoctorAllowFromList = [];
    const seen = new Set<string>();
    for (const entry of out) {
      const keyValue = String(entry).trim();
      if (!keyValue || seen.has(keyValue)) {
        continue;
      }
      seen.add(keyValue);
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

  for (const scope of collectTelegramAccountScopes(next)) {
    for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) {
      await repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

function hasConfiguredGroups(account: DoctorAccountRecord, parent?: DoctorAccountRecord): boolean {
  const groups =
    (account.groups as Record<string, unknown> | undefined) ??
    (parent?.groups as Record<string, unknown> | undefined);
  return Boolean(groups) && Object.keys(groups ?? {}).length > 0;
}

type CollectTelegramGroupPolicyWarningsParams = {
  account: DoctorAccountRecord;
  prefix: string;
  effectiveAllowFrom?: DoctorAllowFromList;
  dmPolicy?: string;
  parent?: DoctorAccountRecord;
};

export function collectTelegramGroupPolicyWarnings(
  params: CollectTelegramGroupPolicyWarningsParams,
): string[] {
  if (!hasConfiguredGroups(params.account, params.parent)) {
    const effectiveDmPolicy = params.dmPolicy ?? "pairing";
    const dmSetupLine =
      effectiveDmPolicy === "pairing"
        ? "DMs use pairing mode, so new senders must start a chat and be approved before regular messages are accepted."
        : effectiveDmPolicy === "allowlist"
          ? `DMs use allowlist mode, so only sender IDs in ${params.prefix}.allowFrom are accepted.`
          : effectiveDmPolicy === "open"
            ? "DMs are open."
            : "DMs are disabled.";
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. ${dmSetupLine} Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.groupAllowFrom as DoctorAllowFromList | undefined);
  // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
  // unset and falls back to allowFrom.
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const effectiveGroupAllowFrom = groupAllowFrom ?? params.effectiveAllowFrom;

  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return [];
  }

  return [
    `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set ${params.prefix}.groupPolicy to "open".`,
  ];
}

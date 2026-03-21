import {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry,
} from "../../../../extensions/telegram/api.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasAllowFromEntries } from "../shared/allowlist.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";

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

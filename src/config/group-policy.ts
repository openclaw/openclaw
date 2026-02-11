import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "./config.js";
import type { ContactsConfig } from "./types.contacts.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type GroupPolicyChannel = ChannelId;

export type ChannelGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type ChannelDmConfig = {
  verified?: boolean;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type ChannelGroupPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
  groupConfig?: ChannelGroupConfig;
  defaultConfig?: ChannelGroupConfig;
};

type ChannelGroups = Record<string, ChannelGroupConfig>;

const CHANNEL_VERIFIED_DEFAULTS: Record<string, boolean> = {
  whatsapp: true,
  imessage: true,
  signal: true,
  sms: false,
};

function resolveChannelGroupConfig(
  groups: ChannelGroups | undefined,
  groupId: string,
  caseInsensitive = false,
): ChannelGroupConfig | undefined {
  if (!groups) {
    return undefined;
  }
  const direct = groups[groupId];
  if (direct) {
    return direct;
  }
  if (!caseInsensitive) {
    return undefined;
  }
  const target = groupId.toLowerCase();
  const matchedKey = Object.keys(groups).find((key) => key !== "*" && key.toLowerCase() === target);
  if (!matchedKey) {
    return undefined;
  }
  return groups[matchedKey];
}

export type GroupToolPolicySender = {
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

function normalizeSenderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  // Don't strip @ for group references — handle those separately
  if (trimmed.startsWith("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function normalizePhoneKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.toLowerCase();
}

/**
 * Merge two tool policies, with override taking precedence.
 * Used to combine group-level and reference-site policies.
 */
function mergeToolPolicies(
  base: GroupToolPolicyConfig | undefined,
  override: GroupToolPolicyConfig | undefined,
): GroupToolPolicyConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  // Override takes precedence for allow/deny, but we merge alsoAllow
  const result: GroupToolPolicyConfig = {};

  const allow = override.allow ?? base.allow;
  if (allow) {
    result.allow = allow;
  }

  const deny = override.deny ?? base.deny;
  if (deny) {
    result.deny = deny;
  }

  const alsoAllow = [...(base.alsoAllow ?? []), ...(override.alsoAllow ?? [])].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  if (alsoAllow.length > 0) {
    result.alsoAllow = alsoAllow;
  }

  return result;
}

/**
 * Resolve a group member to a phone number.
 * If the member is an entry key, looks it up in contacts.entries.
 * If it looks like a phone number (starts with +), uses it directly.
 */
function resolveMemberToPhone(
  member: string,
  contacts: ContactsConfig | undefined,
): string | undefined {
  const trimmed = member.trim();
  if (!trimmed) {
    return undefined;
  }
  // If it looks like a phone number, use directly
  if (trimmed.startsWith("+")) {
    return trimmed;
  }
  // Otherwise, look up in entries
  const entry = contacts?.entries?.[trimmed];
  return entry?.phone;
}

/**
 * Get entry-level tool policy for a phone number.
 * Returns the tools config if the phone matches an entry.
 */
function getEntryToolsForPhone(
  phone: string,
  contacts: ContactsConfig | undefined,
): GroupToolPolicyConfig | undefined {
  if (!contacts?.entries) {
    return undefined;
  }
  const normalizedPhone = normalizePhoneKey(phone);
  for (const entry of Object.values(contacts.entries)) {
    if (normalizePhoneKey(entry.phone) === normalizedPhone) {
      return entry.tools;
    }
  }
  return undefined;
}

/**
 * Expand a group reference to a map of phone numbers -> policies.
 * Handles entry-level overrides and group-level defaults.
 */
function expandGroupReference(
  groupName: string,
  referenceSitePolicy: GroupToolPolicyConfig | undefined,
  contacts: ContactsConfig | undefined,
): Map<string, GroupToolPolicyConfig> {
  const result = new Map<string, GroupToolPolicyConfig>();

  if (!contacts?.groups) {
    return result;
  }

  const group = contacts.groups[groupName];
  if (!group) {
    return result;
  }

  // Base policy = group-level merged with reference-site policy
  const basePolicy = mergeToolPolicies(group.tools, referenceSitePolicy);

  for (const member of group.members) {
    const phone = resolveMemberToPhone(member, contacts);
    if (!phone) {
      continue;
    }

    // Entry-level tools override group-level
    const entryTools = getEntryToolsForPhone(phone, contacts);
    const finalPolicy = entryTools ?? basePolicy;

    if (finalPolicy) {
      result.set(normalizePhoneKey(phone), finalPolicy);
    }
  }

  return result;
}

export function resolveToolsBySender(
  params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
    contacts?: ContactsConfig;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return undefined;
  }
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return undefined;
  }

  // Build lookup map, expanding group references in config order.
  // First match wins, so order in config determines priority.
  const phoneLookup = new Map<string, GroupToolPolicyConfig>();
  let wildcard: GroupToolPolicyConfig | undefined;

  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const key = normalizeSenderKey(rawKey);
    if (!key) {
      continue;
    }

    // Handle wildcard
    if (key === "*") {
      wildcard = policy;
      continue;
    }

    // Handle group references (start with @)
    if (key.startsWith("@")) {
      const groupName = key.slice(1);
      const expanded = expandGroupReference(groupName, policy, params.contacts);
      for (const [phone, groupPolicy] of expanded) {
        // First match wins — don't overwrite existing entries
        if (!phoneLookup.has(phone)) {
          phoneLookup.set(phone, groupPolicy);
        }
      }
      continue;
    }

    // Handle direct phone/sender entries
    if (!phoneLookup.has(key)) {
      phoneLookup.set(key, policy);
    }
  }

  // Build candidate list from sender info
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    candidates.push(trimmed);
  };
  pushCandidate(params.senderId);
  pushCandidate(params.senderE164);
  pushCandidate(params.senderUsername);
  pushCandidate(params.senderName);

  // Look up sender in the expanded map
  for (const candidate of candidates) {
    const key = normalizePhoneKey(candidate);
    if (!key) {
      continue;
    }
    const match = phoneLookup.get(key);
    if (match) {
      return match;
    }
  }

  return wildcard;
}

function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as
    | {
        accounts?: Record<string, { groups?: ChannelGroups }>;
        groups?: ChannelGroups;
      }
    | undefined;
  if (!channelConfig) {
    return undefined;
  }
  const accountGroups = resolveAccountConfig(channelConfig.accounts, normalizedAccountId)?.groups;
  return accountGroups ?? channelConfig.groups;
}

function resolveAccountConfig<T>(
  accounts: Record<string, T> | undefined,
  normalizedAccountId: string,
): T | undefined {
  if (!accounts) {
    return undefined;
  }
  return (
    accounts[normalizedAccountId] ??
    accounts[
      Object.keys(accounts).find(
        (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
      ) ?? ""
    ]
  );
}

function resolveChannelDmConfigs(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): { account?: ChannelDmConfig; channel?: ChannelDmConfig } {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as
    | (ChannelDmConfig & {
        accounts?: Record<string, ChannelDmConfig>;
      })
    | undefined;
  if (!channelConfig) {
    return {};
  }
  return {
    account: resolveAccountConfig(channelConfig.accounts, normalizedAccountId),
    channel: channelConfig,
  };
}

function resolveChannelVerifiedFlag(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): boolean {
  const { account, channel: channelConfig } = resolveChannelDmConfigs(cfg, channel, accountId);
  if (typeof account?.verified === "boolean") {
    return account.verified;
  }
  if (typeof channelConfig?.verified === "boolean") {
    return channelConfig.verified;
  }
  return CHANNEL_VERIFIED_DEFAULTS[channel.trim().toLowerCase()] ?? false;
}

export function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
}): ChannelGroupPolicy {
  const { cfg, channel } = params;
  const groups = resolveChannelGroups(cfg, channel, params.accountId);
  const allowlistEnabled = Boolean(groups && Object.keys(groups).length > 0);
  const normalizedId = params.groupId?.trim();
  const groupConfig = normalizedId
    ? resolveChannelGroupConfig(groups, normalizedId, params.groupIdCaseInsensitive)
    : undefined;
  const defaultConfig = groups?.["*"];
  const allowAll = allowlistEnabled && Boolean(groups && Object.hasOwn(groups, "*"));
  const allowed = !allowlistEnabled || allowAll || Boolean(groupConfig);
  return {
    allowlistEnabled,
    allowed,
    groupConfig,
    defaultConfig,
  };
}

export function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean {
  const { requireMentionOverride, overrideOrder = "after-config" } = params;
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === "boolean"
        ? defaultConfig.requireMention
        : undefined;

  if (overrideOrder === "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (overrideOrder !== "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  return true;
}

export function resolveChannelGroupToolsPolicy(
  params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  const groupSenderPolicy = resolveToolsBySender({
    toolsBySender: groupConfig?.toolsBySender,
    contacts: params.cfg.contacts,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (groupSenderPolicy) {
    return groupSenderPolicy;
  }
  if (groupConfig?.tools) {
    return groupConfig.tools;
  }
  const defaultSenderPolicy = resolveToolsBySender({
    toolsBySender: defaultConfig?.toolsBySender,
    contacts: params.cfg.contacts,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (defaultSenderPolicy) {
    return defaultSenderPolicy;
  }
  if (defaultConfig?.tools) {
    return defaultConfig.tools;
  }
  return undefined;
}

export function resolveChannelDMToolsPolicy(
  params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    accountId?: string | null;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const { cfg, channel, accountId } = params;
  const { account, channel: channelConfig } = resolveChannelDmConfigs(cfg, channel, accountId);
  const verified = resolveChannelVerifiedFlag(cfg, channel, accountId);
  const resolvePolicy = (toolsBySender?: GroupToolPolicyBySenderConfig) =>
    verified
      ? resolveToolsBySender({
          toolsBySender,
          contacts: cfg.contacts,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
        })
      : resolveToolsBySender({ toolsBySender });

  return resolvePolicy(account?.toolsBySender) ?? resolvePolicy(channelConfig?.toolsBySender);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact Context Resolution
// ─────────────────────────────────────────────────────────────────────────────

export type ContactEntryResolved = {
  /** The key used to define this contact in contacts.entries. */
  key: string;
  /** Phone number in E.164 format. */
  phone: string;
  /** Display name from the contact entry. */
  name?: string;
  /** Email address from the contact entry. */
  email?: string;
};

export type ContactGroupResolved = {
  /** The key used to define this group in contacts.groups. */
  key: string;
  /** Instructions defined for this group, injected into prompt context. */
  instructions?: string;
};

export type ContactContext = {
  /** The matched contact entry, if sender is in the registry. */
  entry?: ContactEntryResolved;
  /** All groups the sender belongs to, in config order. */
  groups: ContactGroupResolved[];
  /** Whether the sender's identity is cryptographically verified by the channel. */
  verified: boolean;
  /** Consolidated instructions from all matching groups (joined with newlines). */
  instructions?: string;
  /** Whether the sender is a registered owner. */
  isOwner: boolean;
};

/**
 * Find a contact entry by phone number.
 */
export function resolveContactEntry(
  contacts: ContactsConfig | undefined,
  phone: string | undefined | null,
): ContactEntryResolved | undefined {
  if (!contacts?.entries || !phone) {
    return undefined;
  }
  const normalizedPhone = normalizePhoneKey(phone);
  if (!normalizedPhone) {
    return undefined;
  }
  for (const [key, entry] of Object.entries(contacts.entries)) {
    if (normalizePhoneKey(entry.phone) === normalizedPhone) {
      return {
        key,
        phone: entry.phone,
        name: entry.name,
        email: entry.email,
      };
    }
  }
  return undefined;
}

/**
 * Find all groups a phone number belongs to, in config order.
 */
export function resolveContactGroups(
  contacts: ContactsConfig | undefined,
  phone: string | undefined | null,
): ContactGroupResolved[] {
  if (!contacts?.groups || !phone) {
    return [];
  }
  const normalizedPhone = normalizePhoneKey(phone);
  if (!normalizedPhone) {
    return [];
  }

  const result: ContactGroupResolved[] = [];

  for (const [groupKey, group] of Object.entries(contacts.groups)) {
    for (const member of group.members) {
      const memberPhone = resolveMemberToPhone(member, contacts);
      if (memberPhone && normalizePhoneKey(memberPhone) === normalizedPhone) {
        result.push({
          key: groupKey,
          instructions: group.instructions,
        });
        break; // Found in this group, move to next group
      }
    }
  }

  return result;
}

/**
 * Resolve full contact context for a sender.
 *
 * This is the main entry point for contact-aware features. It returns:
 * - The matched contact entry (if in registry)
 * - All groups the contact belongs to
 * - Whether the channel verifies sender identity
 * - Consolidated instructions from all matching groups
 * - Whether the sender is a registered owner
 */
export function resolveContactContext(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderE164?: string | null;
  ownerNumbers?: string[];
}): ContactContext {
  const { cfg, channel, accountId, senderE164, ownerNumbers } = params;
  const contacts = cfg.contacts;

  // Resolve channel verification flag
  const verified = channel
    ? resolveChannelVerifiedFlag(cfg, channel as GroupPolicyChannel, accountId)
    : false;

  // Check if sender is an owner
  const normalizedSenderPhone = senderE164 ? normalizePhoneKey(senderE164) : undefined;
  const isOwner = Boolean(
    normalizedSenderPhone &&
    ownerNumbers?.some((num) => normalizePhoneKey(num) === normalizedSenderPhone),
  );

  // If not verified, return minimal context (no registry lookups)
  if (!verified) {
    return {
      entry: undefined,
      groups: [],
      verified: false,
      instructions: undefined,
      isOwner,
    };
  }

  // Resolve contact entry and groups
  const entry = resolveContactEntry(contacts, senderE164);
  const groups = resolveContactGroups(contacts, senderE164);

  // Consolidate instructions from all groups
  const instructionsList = groups
    .map((g) => g.instructions)
    .filter((i): i is string => Boolean(i?.trim()));
  const instructions = instructionsList.length > 0 ? instructionsList.join("\n\n") : undefined;

  return {
    entry,
    groups,
    verified,
    instructions,
    isOwner,
  };
}

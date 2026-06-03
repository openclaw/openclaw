import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  parseAccessGroupAllowFromEntry,
} from "../channels/allow-from.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { ACCESS_GROUP_ALLOW_FROM_PREFIX, parseAccessGroupAllowFromEntry };

/** Resolves membership for an access group using the full OpenClaw config. */
export type AccessGroupMembershipResolver = (params: {
  /** Canonical config for dynamic group membership lookups. */
  cfg: OpenClawConfig;
  /** Access group name without the `accessGroup:` prefix. */
  name: string;
  /** Selected group config from `cfg.accessGroups[name]`. */
  group: AccessGroupConfig;
  /** Channel whose allowlist is being evaluated. */
  channel: ChannelId;
  /** Account scope for channel-specific membership lookups. */
  accountId: string;
  /** Sender id being tested against the group. */
  senderId: string;
}) => boolean | Promise<boolean>;

/** Resolves membership for one access group when the caller already selected the config group. */
export type AccessGroupMembershipLookup = (params: {
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;

/** Reports how access-group allowlist entries resolved for a channel sender. */
export type ResolvedAccessGroupAllowFromState = {
  /** Unique access group names referenced by the original allowlist. */
  referenced: string[];
  /** Referenced groups that authorized the sender. */
  matched: string[];
  /** Referenced groups absent from current config. */
  missing: string[];
  /** Referenced groups needing dynamic membership when no resolver was supplied. */
  unsupported: string[];
  /** Referenced groups whose dynamic membership resolver threw. */
  failed: string[];
  /** Matched entries re-rendered as `accessGroup:<name>` allowlist values. */
  matchedAllowFromEntries: string[];
  hasReferences: boolean;
  hasMatch: boolean;
};

function resolveMessageSenderGroupEntries(params: {
  group: AccessGroupConfig;
  channel: ChannelId;
}): string[] {
  if (params.group.type !== "message.senders") {
    return [];
  }
  return [...(params.group.members["*"] ?? []), ...(params.group.members[params.channel] ?? [])];
}

/** Resolves `accessGroup:<name>` allowlist entries without changing the original allowlist. */
export async function resolveAccessGroupAllowFromState(params: {
  /** Configured access groups keyed by name. Undefined makes all references missing. */
  accessGroups?: Record<string, AccessGroupConfig>;
  /** Original allowlist entries, including optional `accessGroup:<name>` references. */
  allowFrom: Array<string | number> | null | undefined;
  /** Channel id for static message.senders channel-specific entries. */
  channel: ChannelId;
  /** Account scope passed to dynamic membership resolver. */
  accountId: string;
  /** Sender id tested against static and dynamic group membership. */
  senderId: string;
  /** Channel matcher used for static message.senders entries. */
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  /** Optional dynamic resolver for non-static group types. */
  resolveMembership?: AccessGroupMembershipLookup;
}): Promise<ResolvedAccessGroupAllowFromState> {
  const names = Array.from(
    new Set(
      (params.allowFrom ?? [])
        .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
        .filter((entry): entry is string => entry != null),
    ),
  );
  const state: ResolvedAccessGroupAllowFromState = {
    referenced: names,
    matched: [],
    missing: [],
    unsupported: [],
    failed: [],
    matchedAllowFromEntries: [],
    hasReferences: names.length > 0,
    hasMatch: false,
  };
  const groups = params.accessGroups;
  for (const name of names) {
    const group = groups?.[name];
    if (!group) {
      state.missing.push(name);
      continue;
    }

    const senderEntries = resolveMessageSenderGroupEntries({
      group,
      channel: params.channel,
    });
    if (
      senderEntries.length > 0 &&
      params.isSenderAllowed?.(params.senderId, senderEntries) === true
    ) {
      state.matched.push(name);
      continue;
    }

    if (!params.resolveMembership) {
      // `message.senders` can resolve locally. Other group types require a channel/plugin-owned
      // resolver, so mark them unsupported instead of guessing membership.
      if (group.type !== "message.senders") {
        state.unsupported.push(name);
      }
      continue;
    }

    let allowed;
    try {
      allowed = await params.resolveMembership({
        name,
        group,
        channel: params.channel,
        accountId: params.accountId,
        senderId: params.senderId,
      });
    } catch {
      state.failed.push(name);
      continue;
    }
    if (allowed) {
      state.matched.push(name);
    }
  }
  state.matchedAllowFromEntries = state.matched.map(
    (name) => `${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`,
  );
  state.hasMatch = state.matchedAllowFromEntries.length > 0;
  return state;
}

/** Returns the matched `accessGroup:<name>` allowlist entries for a sender. */
export async function resolveAccessGroupAllowFromMatches(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]> {
  const cfg = params.cfg;
  const resolveMembership = params.resolveMembership;
  const state = await resolveAccessGroupAllowFromState({
    accessGroups: cfg?.accessGroups,
    allowFrom: params.allowFrom,
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
    resolveMembership:
      resolveMembership && cfg
        ? async (lookupParams) =>
            await resolveMembership({
              cfg,
              ...lookupParams,
            })
        : undefined,
  });
  return state.matchedAllowFromEntries;
}

/** Expands a matching access-group allowlist with the concrete sender entry. */
export async function expandAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  senderAllowEntry?: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const matched = await resolveAccessGroupAllowFromMatches({
    cfg: params.cfg,
    allowFrom,
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
    resolveMembership: params.resolveMembership,
  });
  if (matched.length === 0) {
    return allowFrom;
  }
  const senderEntry = params.senderAllowEntry ?? params.senderId;
  // Downstream legacy sender checks still expect a concrete allowlist entry after a group match.
  return uniqueStrings([...allowFrom, senderEntry]);
}

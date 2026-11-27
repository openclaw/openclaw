import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareChannelOperatorAdmin,
  type resolveChannelOperatorAdminAuthority,
  type ResolvedChannelOperatorIdentity,
} from "../gateway/channel-operator-authority.js";
import { normalizeAccountId } from "../routing/account-id.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { CommandOwnerReference } from "../state/user-channel-authorization-reference.js";
import { prepareConfiguredCommandOwnerAuthority } from "../state/user-channel-identity-operations.js";
import type { CommandOwnerAssertion } from "./command-owner-authority.js";
import {
  formatAllowFromList,
  resolveSenderCandidates,
  stripWildcardAllowFrom,
  type AllowFromParams,
} from "./sender-identity.js";

export function resolveOwnerAllowFromList(
  params: AllowFromParams & {
    providerId?: ChannelId;
    allowFrom?: Array<string | number>;
    migrationDeferredChannels?: readonly string[];
  },
): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const trimmed of normalizeStringEntries(raw.map((entry) => entry ?? ""))) {
    const separatorIndex = trimmed.indexOf(":");
    const prefix = trimmed.slice(0, separatorIndex);
    // Bundled channel metadata names the prefix when its plugin is not loaded in this process.
    const channel =
      separatorIndex > 0
        ? (normalizeAnyChannelId(prefix) ?? normalizeChatChannelId(prefix))
        : undefined;
    if (!channel) {
      filtered.push(trimmed);
      continue;
    }
    if (channel !== params.providerId) {
      continue;
    }
    const remainder = trimmed.slice(separatorIndex + 1).trim();
    // Normally the channel formats its typed direct target. A delegated update may lack the
    // formatter while Doctor owns the channel plugin's migration; the exact user ID still names
    // the owner. Without the plugin, its target style is unknown, so this accepts the typed
    // form for any deferred channel; the ID must still match the sender exactly.
    if (
      normalizeChatChannelId(prefix) &&
      /^[^:]+:user:[^:\s*]+$/i.test(trimmed) &&
      params.plugin?.messaging?.directTargetStyle !== "user-prefixed"
    ) {
      if (!params.plugin && params.migrationDeferredChannels?.includes(channel)) {
        filtered.push(remainder.slice("user:".length));
      }
      continue;
    }
    if (remainder) {
      filtered.push(remainder);
    }
  }
  return formatAllowFromList({ ...params, allowFrom: filtered });
}

/** Configured owners that a turn on this channel account renders; a config fact, not authority. */
export function resolveConfiguredCommandOwners(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string },
): string[] {
  const providerId = normalizeAnyChannelId(requester.channel) ?? requester.channel;
  const plugin = providerId ? getLoadedChannelPluginForRead(providerId) : undefined;
  const params = { cfg, plugin, providerId, accountId: requester.accountId };
  return Array.from(new Set(stripWildcardAllowFrom(resolveOwnerAllowFromList(params))));
}

export function isConfiguredCommandOwner(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string; senderE164?: string },
  options: { migrationDeferredChannels?: readonly string[] } = {},
): boolean {
  const providerId = normalizeAnyChannelId(requester.channel) ?? requester.channel;
  const plugin = providerId ? getLoadedChannelPluginForRead(providerId) : undefined;
  const owners = stripWildcardAllowFrom(
    resolveOwnerAllowFromList({
      cfg,
      plugin,
      providerId,
      accountId: requester.accountId,
      ...options,
    }),
  );
  return resolveSenderCandidates({
    cfg,
    plugin,
    accountId: requester.accountId,
    senderId: requester.senderId,
    senderE164: requester.senderE164,
  }).some((sender) => owners.includes(sender));
}

function resolveCommandOwnerIdentity(requester?: {
  channel?: string;
  accountId?: string;
  senderId?: string;
}) {
  const providerId = normalizeAnyChannelId(requester?.channel) ?? requester?.channel;
  return providerId && requester?.senderId
    ? {
        channelId: providerId,
        accountId: normalizeAccountId(requester.accountId),
        senderId: requester.senderId,
      }
    : undefined;
}

/** Synchronous capture (CLI, update driver); deferred effects keep the original person grant. */
export function captureCommandOwnerIdentity(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
  stateOptions: OpenClawStateDatabaseOptions,
  resolveProfile: typeof resolveChannelOperatorAdminAuthority,
): PreparedCommandOwnerAuthority {
  const captured = { ...requester };
  if (isConfiguredCommandOwner(cfg, captured)) {
    return Object.freeze({
      source: "configured-owner",
      isCurrent: (currentCfg: OpenClawConfig) => isConfiguredCommandOwner(currentCfg, captured),
    });
  }
  const identity = resolveCommandOwnerIdentity(captured);
  const authority = identity ? resolveProfile(cfg, identity, stateOptions) : undefined;
  return Object.freeze({
    source: authority ? `profile:${authority.profileId}` : undefined,
    ...(authority?.signal ? { signal: authority.signal } : {}),
    isCurrent: (currentCfg: OpenClawConfig) =>
      authority !== undefined &&
      !isConfiguredCommandOwner(currentCfg, captured) &&
      authority.isCurrent(currentCfg),
  });
}

export type PreparedCommandOwnerAuthority = Readonly<{
  source: string | undefined;
  recoveryReference?: Exclude<CommandOwnerAssertion["recoveryReference"], null>;
  isCurrent: (currentCfg: OpenClawConfig) => boolean;
  /** The original additional person-policy grant, never a substitute for the current check. */
  signal?: AbortSignal;
}>;

/** Admission and recovery share the original authority owner; final checks never touch SQLite. */
export async function prepareCommandOwnerAuthority(
  cfg: OpenClawConfig,
  requester:
    | { channel?: string; accountId?: string; senderId?: string; senderE164?: string }
    | CommandOwnerReference
    | ResolvedChannelOperatorIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
): Promise<PreparedCommandOwnerAuthority> {
  const resolved = "identity" in requester ? requester : undefined;
  const captured =
    "identity" in requester
      ? {
          channel: requester.identity.channelId,
          accountId: requester.identity.accountId,
          senderId: requester.identity.senderId,
        }
      : "version" in requester
        ? undefined
        : { ...requester };
  const reference = "version" in requester ? requester : undefined;
  if (reference?.version === 2 || (captured && isConfiguredCommandOwner(cfg, captured))) {
    const prepared = await prepareConfiguredCommandOwnerAuthority(
      cfg.commands?.ownerAllowFrom,
      stateOptions,
    );
    const accepted = !reference || prepared?.recoveryReference.id === reference.id;
    return Object.freeze({
      source: accepted ? "configured-owner" : undefined,
      recoveryReference: prepared?.recoveryReference,
      // Live configured admission remains config-owned; an absent durable policy cannot recover.
      isCurrent: (currentCfg: OpenClawConfig) =>
        accepted &&
        (prepared ? prepared.isCurrent() : !reference) &&
        (!captured || isConfiguredCommandOwner(currentCfg, captured)),
    });
  }
  const identity = reference ?? resolveCommandOwnerIdentity(captured);
  const prepared =
    identity && (await prepareChannelOperatorAdmin(cfg, resolved ?? identity, stateOptions));
  return Object.freeze({
    source: prepared ? `profile:${prepared.profileId}` : undefined,
    recoveryReference: prepared?.recoveryReference,
    ...(prepared?.signal ? { signal: prepared.signal } : {}),
    isCurrent: (currentCfg: OpenClawConfig) =>
      prepared !== undefined &&
      (!captured || !isConfiguredCommandOwner(currentCfg, captured)) &&
      prepared.isCurrent(currentCfg),
  });
}

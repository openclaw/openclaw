import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginForRead,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareChannelOperatorAdmin,
  resolveChannelOperatorAdminAuthority,
  resolveUpdateChannelOperatorAdminIdentityAuthority,
  type ResolvedChannelOperatorIdentity,
} from "../gateway/channel-operator-authority.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { CommandOwnerReference } from "../state/user-channel-identities.js";
import { prepareConfiguredCommandOwnerAuthority } from "../state/user-channel-identity-operations.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
  type CommandOwnerAssertion,
} from "./command-owner-authority.js";
import { getCommandSenderAuthority } from "./command-sender-authority.js";
import {
  formatAllowFromList,
  normalizeAllowFromEntry,
  resolveSenderCandidates,
  type AllowFromParams,
} from "./sender-identity.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  /** Rechecks the host-admitted owner capability after awaited work, when one is present. */
  assertOwnerCurrent?: () => void;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

type CommandAuthorizationParams = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
};

type CommandSenderAccess = "denied" | "reset-only" | "commands";

type ProviderResolution = {
  providerId: ChannelId;
  hadResolutionError: boolean;
};

type AllowFromAccountConfig = {
  allowFrom?: Array<string | number>;
  dm?: { allowFrom?: Array<string | number> };
};

type AllowFromChannelConfig = AllowFromAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, AllowFromAccountConfig | undefined>;
};

function resolveProviderFromContext(
  ctx: MsgContext,
  cfg: OpenClawConfig,
): { providerId: ChannelId | undefined; hadResolutionError: boolean } {
  const explicitMessageChannels = [ctx.Surface, ctx.OriginatingChannel, ctx.Provider]
    .map((value) => normalizeMessageChannel(value))
    .filter((value): value is string => Boolean(value));
  const explicitMessageChannel = explicitMessageChannels.find(
    (value) => value !== INTERNAL_MESSAGE_CHANNEL,
  );
  if (!explicitMessageChannel && explicitMessageChannels.includes(INTERNAL_MESSAGE_CHANNEL)) {
    return { providerId: undefined, hadResolutionError: false };
  }
  const direct =
    normalizeAnyChannelId(explicitMessageChannel ?? undefined) ??
    (explicitMessageChannel as ChannelId | undefined) ??
    normalizeAnyChannelId(ctx.Provider) ??
    normalizeAnyChannelId(ctx.Surface) ??
    normalizeAnyChannelId(ctx.OriginatingChannel);
  if (direct) {
    return { providerId: direct, hadResolutionError: false };
  }
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalizedCandidateChannel = normalizeMessageChannel(candidate);
    if (normalizedCandidateChannel === INTERNAL_MESSAGE_CHANNEL) {
      return { providerId: undefined, hadResolutionError: false };
    }
    const normalized =
      normalizeAnyChannelId(normalizedCandidateChannel ?? undefined) ??
      (normalizedCandidateChannel as ChannelId | undefined) ??
      normalizeAnyChannelId(candidate);
    if (normalized) {
      return { providerId: normalized, hadResolutionError: false };
    }
  }
  let droppedResolutionError = false;
  const inferredCandidates: ProviderResolution[] = [];
  for (const plugin of listLoadedChannelPlugins()) {
    const resolved = resolveProviderAllowFrom({
      plugin,
      cfg,
      accountId: ctx.AccountId,
    });
    if (resolved.allowFromList.length > 0) {
      inferredCandidates.push({
        providerId: plugin.id,
        hadResolutionError: resolved.hadResolutionError,
      });
    } else if (resolved.hadResolutionError) {
      droppedResolutionError = true;
    }
  }
  const inferred = inferredCandidates[0];
  if (inferredCandidates.length === 1 && inferred) {
    return inferred;
  }
  return {
    providerId: undefined,
    hadResolutionError:
      droppedResolutionError || inferredCandidates.some((entry) => entry.hadResolutionError),
  };
}

function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

function stripWildcardAllowFrom(list: string[]): string[] {
  return list.filter((entry) => !isWildcardAllowFromEntry(entry));
}

function resolveProviderAllowFrom(
  params: AllowFromParams & {
    providerId?: ChannelId;
    forceFallbackResolutionError?: boolean;
  },
) {
  const { plugin, cfg, accountId } = params;
  // An unloaded channel has no trusted allowlist owner unless failed provider inference forces it.
  const providerId = params.forceFallbackResolutionError
    ? (params.providerId ?? plugin?.id)
    : plugin?.id;
  const resolveFallback = () => resolveFallbackAllowFrom({ cfg, providerId, accountId });
  let hadResolutionError = Boolean(params.forceFallbackResolutionError);
  let allowFrom: Array<string | number>;

  if (hadResolutionError || !plugin?.config?.resolveAllowFrom) {
    allowFrom = resolveFallback();
  } else {
    try {
      const resolved = plugin.config.resolveAllowFrom({ cfg, accountId });
      if (resolved == null || Array.isArray(resolved)) {
        allowFrom = resolved ?? [];
      } else {
        console.warn(
          `[command-auth] resolveAllowFrom returned an invalid allowFrom for provider "${providerId}", falling back to config allowFrom: invalid_result`,
        );
        hadResolutionError = true;
        allowFrom = resolveFallback();
      }
    } catch (err) {
      console.warn(
        `[command-auth] resolveAllowFrom threw for provider "${providerId}", falling back to config allowFrom: ${describeAllowFromResolutionError(err)}`,
      );
      hadResolutionError = true;
      allowFrom = resolveFallback();
    }
  }
  return {
    allowFromList: formatAllowFromList({ plugin, cfg, accountId, allowFrom }),
    hadResolutionError,
  };
}

function describeAllowFromResolutionError(err: unknown): string {
  return err instanceof Error ? (normalizeOptionalString(err.name) ?? "Error") : "unknown_error";
}

function resolveOwnerAllowFromList(
  params: AllowFromParams & { providerId?: ChannelId; allowFrom?: Array<string | number> },
): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const trimmed of normalizeStringEntries(raw.map((entry) => entry ?? ""))) {
    const separatorIndex = trimmed.indexOf(":");
    const prefix = trimmed.slice(0, separatorIndex);
    const channel = separatorIndex > 0 ? normalizeAnyChannelId(prefix) : undefined;
    if (!channel) {
      filtered.push(trimmed);
      continue;
    }
    // Typed direct targets are canonical for plugins that require the user kind.
    // Their allowlist formatter owns the conversion to a native sender identity.
    if (
      !params.providerId ||
      channel !== params.providerId ||
      (normalizeChatChannelId(prefix) &&
        /^[^:]+:user:[^:\s*]+$/i.test(trimmed) &&
        params.plugin?.messaging?.directTargetStyle !== "user-prefixed")
    ) {
      continue;
    }
    const remainder = trimmed.slice(separatorIndex + 1).trim();
    if (remainder) {
      filtered.push(remainder);
    }
  }
  return formatAllowFromList({ ...params, allowFrom: filtered });
}

/**
 * Resolves the commands.allowFrom list for a given provider.
 * Returns the provider-specific list if defined, otherwise the "*" global list.
 * Returns null if commands.allowFrom is not configured at all (fall back to channel allowFrom).
 */
function resolveCommandsAllowFromList(
  params: AllowFromParams & { providerId?: ChannelId },
): string[] | null {
  const commandsAllowFrom = params.cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    // An absent command allowlist falls back to the channel's allowFrom.
    return null;
  }

  const providerKey = params.providerId ?? "";
  const providerList = commandsAllowFrom[providerKey];
  const globalList = commandsAllowFrom["*"];

  const rawList = Array.isArray(providerList) ? providerList : globalList;
  if (!Array.isArray(rawList)) {
    return null;
  }

  return formatAllowFromList({ ...params, allowFrom: rawList });
}

function resolveOwnerAuthorizationState(
  params: AllowFromParams & {
    providerId?: ChannelId;
    to?: string;
    allowFromList: string[];
    hadResolutionError: boolean;
    contextOwnerAllowFrom?: Array<string | number>;
  },
) {
  const configOwnerAllowFromList = resolveOwnerAllowFromList(params);
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    ...params,
    allowFrom: params.contextOwnerAllowFrom,
  });
  const allowAll =
    !params.hadResolutionError &&
    (params.allowFromList.length === 0 || params.allowFromList.some(isWildcardAllowFromEntry));
  const channelCommandOwners = allowAll ? [] : stripWildcardAllowFrom(params.allowFromList);
  if (!allowAll && channelCommandOwners.length === 0 && params.to) {
    channelCommandOwners.push(...normalizeAllowFromEntry({ ...params, value: params.to }));
  }
  const explicitOwners = Array.from(new Set(stripWildcardAllowFrom(configOwnerAllowFromList)));
  const contextCommandOwners = stripWildcardAllowFrom(contextOwnerAllowFromList);
  // Channel and context lists can authorize commands within one transport, but only the global
  // owner list grants owner-only command and action authority.
  const commandOwnerCandidates = Array.from(
    new Set(
      explicitOwners.length > 0
        ? explicitOwners
        : contextCommandOwners.length > 0
          ? contextCommandOwners
          : channelCommandOwners,
    ),
  );
  return {
    commandOwnerCandidates,
    explicitOwners,
  };
}

function resolveCommandSenderAuthorization(params: {
  commandAuthorized: boolean;
  enforceOwnerForCommands: boolean;
  isOwnerForCommands: boolean;
  senderCandidates: string[];
  commandsAllowFromList: string[] | null;
  providerResolutionError: boolean;
  commandsAllowFromConfigured: boolean;
}): CommandSenderAccess {
  if (params.enforceOwnerForCommands && !params.isOwnerForCommands) {
    return "denied";
  }
  if (
    params.commandsAllowFromList !== null ||
    (params.providerResolutionError && params.commandsAllowFromConfigured)
  ) {
    if (params.providerResolutionError) {
      return "denied";
    }
    return params.commandsAllowFromList?.some(
      (entry) => isWildcardAllowFromEntry(entry) || params.senderCandidates.includes(entry),
    )
      ? "commands"
      : "denied";
  }
  if (!params.commandAuthorized) {
    return "denied";
  }
  // Global ownership does not revoke channel-admitted session resets; explicit
  // channel owner enforcement and commands.allowFrom have already been applied.
  return params.isOwnerForCommands ? "commands" : "reset-only";
}

function resolveFallbackAllowFrom(params: {
  cfg: OpenClawConfig;
  providerId?: ChannelId;
  accountId?: string | null;
}): Array<string | number> {
  const providerId = normalizeOptionalString(params.providerId);
  if (!providerId) {
    return [];
  }
  const channels = params.cfg.channels as
    | Record<string, AllowFromChannelConfig | undefined>
    | undefined;
  const channelCfg = channels?.[providerId];
  let accountCfg = resolveFallbackAccountConfig(channelCfg?.accounts, providerId, params.accountId);
  if (accountCfg == null) {
    const accounts = channelCfg?.accounts;
    if (accounts) {
      accountCfg =
        resolveFallbackAccountConfig(accounts, providerId, channelCfg?.defaultAccount) ??
        resolveFallbackAccountConfig(accounts, providerId, "default");
      if (!accountCfg) {
        const definedAccountIds = Object.keys(accounts).filter((id) => accounts[id]);
        const accountId = definedAccountIds.length === 1 ? definedAccountIds[0] : undefined;
        accountCfg =
          accountId === undefined
            ? undefined
            : resolveChannelAccountEntry(accounts, accountId, providerId);
      }
    }
  }
  const allowFrom =
    accountCfg?.allowFrom ??
    accountCfg?.dm?.allowFrom ??
    channelCfg?.allowFrom ??
    channelCfg?.dm?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : [];
}

function resolveFallbackAccountConfig(
  accounts: AllowFromChannelConfig["accounts"],
  channelId: string,
  accountId?: string | null,
) {
  const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
  if (!accounts || !normalizedAccountId) {
    return undefined;
  }
  return resolveChannelAccountEntry(accounts, normalizedAccountId, channelId);
}

function resolveCommandAuthorizationState(params: CommandAuthorizationParams): {
  authorization: CommandAuthorization;
  access: CommandSenderAccess;
} {
  const { ctx, cfg, commandAuthorized } = params;
  const { providerId, hadResolutionError: providerResolutionError } = resolveProviderFromContext(
    ctx,
    cfg,
  );
  const plugin = providerId ? getLoadedChannelPluginById(providerId) : undefined;
  const from = normalizeOptionalString(ctx.From) ?? "";
  const to = normalizeOptionalString(ctx.To) ?? "";
  const commandsAllowFromConfigured = Boolean(
    cfg.commands?.allowFrom && typeof cfg.commands.allowFrom === "object",
  );

  const providerContext = { plugin, cfg, accountId: ctx.AccountId, providerId };
  const commandsAllowFromList = resolveCommandsAllowFromList(providerContext);
  const resolvedAllowFrom = resolveProviderAllowFrom({
    ...providerContext,
    forceFallbackResolutionError: providerResolutionError,
  });
  const ownerState = resolveOwnerAuthorizationState({
    ...providerContext,
    to,
    allowFromList: resolvedAllowFrom.allowFromList,
    hadResolutionError: resolvedAllowFrom.hadResolutionError,
    contextOwnerAllowFrom: ctx.OwnerAllowFrom,
  });

  const senderCandidates = resolveSenderCandidates({
    ...providerContext,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    commandSenderId: getCommandSenderAuthority(ctx)?.(),
    from,
    chatType: ctx.ChatType,
  });
  const matchedSender = senderCandidates.find((candidate) =>
    ownerState.explicitOwners.includes(candidate),
  );
  const matchedCommandOwner = senderCandidates.find((candidate) =>
    ownerState.commandOwnerCandidates.includes(candidate),
  );
  const senderId = matchedSender ?? matchedCommandOwner ?? senderCandidates[0];

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
  const senderIsOwnerByIdentity = Boolean(matchedSender);
  const senderIsOwnerByScope =
    isInternalMessageChannel(ctx.Provider) &&
    Array.isArray(ctx.GatewayClientScopes) &&
    ctx.GatewayClientScopes.includes("operator.admin");
  const ownerAllowlistConfigured = ownerState.explicitOwners.length > 0;
  const assertOwnerCurrent = captureCommandOwnerAssertion(ctx);
  const senderIsOwner =
    senderIsOwnerByIdentity ||
    senderIsOwnerByScope ||
    getCommandOwnerAuthority(ctx)?.isCurrent() === true;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerAllowlistConfigured
      ? senderIsOwner
      : senderIsOwner || Boolean(matchedCommandOwner);
  // Literal turns cannot regain command access through an allowlist; inline
  // command consumers must preserve their text while owner facts remain intact.
  const access =
    ctx.CommandInterpretationSuppressed === true
      ? "denied"
      : resolveCommandSenderAuthorization({
          commandAuthorized,
          enforceOwnerForCommands: enforceOwner,
          isOwnerForCommands,
          senderCandidates,
          commandsAllowFromList,
          providerResolutionError,
          commandsAllowFromConfigured,
        });

  return {
    authorization: {
      providerId,
      ownerList: ownerState.explicitOwners,
      senderId: senderId || undefined,
      senderIsOwner,
      ...(assertOwnerCurrent ? { assertOwnerCurrent } : {}),
      isAuthorizedSender: access === "commands",
      from: from || undefined,
      to: to || undefined,
    },
    access,
  };
}

export function resolveCommandAuthorization(
  params: CommandAuthorizationParams,
): CommandAuthorization {
  return resolveCommandAuthorizationState(params).authorization;
}

export function isConfiguredCommandOwner(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
): boolean {
  const providerId = normalizeAnyChannelId(requester.channel) ?? requester.channel;
  const plugin = providerId ? getLoadedChannelPluginForRead(providerId) : undefined;
  const params = { cfg, plugin, providerId, accountId: requester.accountId };
  const owners = stripWildcardAllowFrom(resolveOwnerAllowFromList(params));
  return resolveSenderCandidates({ ...params, senderId: requester.senderId }).some((sender) =>
    owners.includes(sender),
  );
}

/** Synchronous CLI capture; deferred effects retain its original person-access grant. */
export function resolveCommandOwnerAuthority(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
  stateOptions: OpenClawStateDatabaseOptions = {},
): PreparedCommandOwnerAuthority {
  return captureCommandOwnerIdentity(
    cfg,
    requester,
    stateOptions,
    resolveChannelOperatorAdminAuthority,
  );
}

/** Additional person policy stays with the original Gateway's accepted update operation. */
export function resolveUpdateRequesterIdentityAuthority(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
  stateOptions: OpenClawStateDatabaseOptions = {},
): PreparedCommandOwnerAuthority {
  return captureCommandOwnerIdentity(
    cfg,
    requester,
    stateOptions,
    resolveUpdateChannelOperatorAdminIdentityAuthority,
  );
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

function captureCommandOwnerIdentity(
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
  operatorProfile?: NonNullable<
    Awaited<ReturnType<typeof prepareChannelOperatorAdmin>>
  >["operatorProfile"];
  recoveryReference?: Exclude<CommandOwnerAssertion["recoveryReference"], null>;
  isCurrent: (currentCfg: OpenClawConfig) => boolean;
  /** The original additional person-policy grant, never a substitute for the current check. */
  signal?: AbortSignal;
}>;

/** Admission and recovery share the original authority owner; final checks never touch SQLite. */
export async function prepareCommandOwnerAuthority(
  cfg: OpenClawConfig,
  requester:
    | { channel?: string; accountId?: string; senderId?: string }
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
    operatorProfile: prepared?.operatorProfile,
    recoveryReference: prepared?.recoveryReference,
    ...(prepared?.signal ? { signal: prepared.signal } : {}),
    isCurrent: (currentCfg: OpenClawConfig) =>
      prepared !== undefined &&
      (!captured || !isConfiguredCommandOwner(currentCfg, captured)) &&
      prepared.isCurrent(currentCfg),
  });
}

/** Resolves reset admission without granting other command or owner authority. */
export function isResetAuthorizedForContext(params: CommandAuthorizationParams): boolean {
  if (resolveCommandAuthorizationState(params).access === "denied") {
    return false;
  }
  const provider = params.ctx.Provider;
  const internalGatewayCaller = provider
    ? isInternalMessageChannel(provider)
    : isInternalMessageChannel(params.ctx.Surface);
  if (!internalGatewayCaller) {
    return true;
  }
  const scopes = params.ctx.GatewayClientScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return true;
  }
  return scopes.includes("operator.admin");
}

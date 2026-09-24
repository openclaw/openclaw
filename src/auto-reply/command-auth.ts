/** Command authorization helpers for owner and allowlist checks. */
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
  prepareChannelOperatorAuthority,
  resolveChannelOperatorAdminAuthority,
  resolveUpdateChannelOperatorAdminIdentityAuthority,
} from "../gateway/channel-operator-authority.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
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

type ProviderAllowFromResolution = {
  allowFrom: Array<string | number>;
  allowFromList: string[];
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

type OwnerAuthorizationState = {
  commandOwnerCandidates: string[];
  explicitOwners: string[];
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
  const inferredProviders = probeInferredProviders(ctx, cfg);
  const inferred = inferredProviders.candidates[0];
  if (inferredProviders.candidates.length === 1 && inferred) {
    return inferred;
  }
  return {
    providerId: undefined,
    hadResolutionError:
      inferredProviders.droppedResolutionError ||
      inferredProviders.candidates.some((entry) => entry.hadResolutionError),
  };
}

function probeInferredProviders(ctx: MsgContext, cfg: OpenClawConfig) {
  let droppedResolutionError = false;
  const candidates: ProviderResolution[] = [];
  for (const plugin of listLoadedChannelPlugins()) {
    const resolved = resolveProviderAllowFrom({
      plugin,
      cfg,
      accountId: ctx.AccountId,
    });
    if (resolved.allowFromList.length > 0) {
      candidates.push({ providerId: plugin.id, hadResolutionError: resolved.hadResolutionError });
    } else if (resolved.hadResolutionError) {
      droppedResolutionError = true;
    }
  }
  return { candidates, droppedResolutionError };
}

function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

function hasWildcardAllowFrom(list: string[]): boolean {
  return list.some((entry) => isWildcardAllowFromEntry(entry));
}

function stripWildcardAllowFrom(list: string[]): string[] {
  return list.filter((entry) => !isWildcardAllowFromEntry(entry));
}

function resolveProviderAllowFrom(
  params: AllowFromParams & {
    providerId?: ChannelId;
    forceFallbackResolutionError?: boolean;
  },
): ProviderAllowFromResolution {
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
    allowFrom,
    allowFromList: formatAllowFromList({ plugin, cfg, accountId, allowFrom }),
    hadResolutionError,
  };
}

function describeAllowFromResolutionError(err: unknown): string {
  if (err instanceof Error) {
    const name = normalizeOptionalString(err.name) ?? "";
    return name || "Error";
  }
  return "unknown_error";
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
    // Doctor owns bundled channel:user:id migration; third-party native identities stay intact.
    if (
      !params.providerId ||
      channel !== params.providerId ||
      (normalizeChatChannelId(prefix) && /^[^:]+:user:[^:\s*]+$/i.test(trimmed))
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
    return null; // Not configured, fall back to channel allowFrom
  }

  // Check provider-specific list first, then fall back to global "*"
  const providerKey = params.providerId ?? "";
  const providerList = commandsAllowFrom[providerKey];
  const globalList = commandsAllowFrom["*"];

  const rawList = Array.isArray(providerList) ? providerList : globalList;
  if (!Array.isArray(rawList)) {
    return null; // No applicable list found
  }

  return formatAllowFromList({ ...params, allowFrom: rawList });
}

function resolveOwnerCandidatesForCommands(
  params: AllowFromParams & { to?: string; allowAll: boolean; allowFromList: string[] },
): string[] {
  if (params.allowAll) {
    return [];
  }
  const ownerCandidatesForCommands = stripWildcardAllowFrom(params.allowFromList);
  if (ownerCandidatesForCommands.length > 0 || !params.to) {
    return ownerCandidatesForCommands;
  }
  return normalizeAllowFromEntry({ ...params, value: params.to });
}

function resolveOwnerAuthorizationState(
  params: AllowFromParams & {
    providerId?: ChannelId;
    to?: string;
    allowFromList: string[];
    hadResolutionError: boolean;
    configOwnerAllowFrom?: Array<string | number>;
    contextOwnerAllowFrom?: Array<string | number>;
  },
): OwnerAuthorizationState {
  const configOwnerAllowFromList = resolveOwnerAllowFromList({
    ...params,
    allowFrom: params.configOwnerAllowFrom,
  });
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    ...params,
    allowFrom: params.contextOwnerAllowFrom,
  });
  const allowAll =
    !params.hadResolutionError &&
    (params.allowFromList.length === 0 || hasWildcardAllowFrom(params.allowFromList));
  const channelCommandOwners = resolveOwnerCandidatesForCommands({ ...params, allowAll });
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
    const commandsAllowFromList = params.commandsAllowFromList;
    const commandsAllowAll =
      !params.providerResolutionError &&
      Boolean(commandsAllowFromList && hasWildcardAllowFrom(commandsAllowFromList));
    const matchedCommandsAllowFrom = commandsAllowFromList?.length
      ? params.senderCandidates.find((candidate) => commandsAllowFromList.includes(candidate))
      : undefined;
    return !params.providerResolutionError &&
      (commandsAllowAll || Boolean(matchedCommandsAllowFrom))
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
  const accountCfg =
    resolveFallbackAccountConfig(channelCfg?.accounts, providerId, params.accountId) ??
    resolveFallbackDefaultAccountConfig(channelCfg, providerId);
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

function resolveFallbackDefaultAccountConfig(
  channelCfg: AllowFromChannelConfig | undefined,
  channelId: string,
) {
  const accounts = channelCfg?.accounts;
  if (!accounts) {
    return undefined;
  }
  const preferred =
    resolveFallbackAccountConfig(accounts, channelId, channelCfg?.defaultAccount) ??
    resolveFallbackAccountConfig(accounts, channelId, "default");
  if (preferred) {
    return preferred;
  }
  const definedAccountIds = Object.keys(accounts).filter((id) => accounts[id]);
  const accountId = definedAccountIds.length === 1 ? definedAccountIds[0] : undefined;
  return accountId === undefined
    ? undefined
    : resolveChannelAccountEntry(accounts, accountId, channelId);
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

  // Check if commands.allowFrom is configured (separate command authorization)
  const commandsAllowFromList = resolveCommandsAllowFromList({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
  });

  const resolvedAllowFrom = resolveProviderAllowFrom({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    forceFallbackResolutionError: providerResolutionError,
  });
  const ownerState = resolveOwnerAuthorizationState({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    to,
    allowFromList: resolvedAllowFrom.allowFromList,
    hadResolutionError: resolvedAllowFrom.hadResolutionError,
    configOwnerAllowFrom: cfg.commands?.ownerAllowFrom,
    contextOwnerAllowFrom: ctx.OwnerAllowFrom,
  });

  const senderCandidates = resolveSenderCandidates({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    commandSenderId: getCommandSenderAuthority(ctx)?.(),
    from,
    chatType: ctx.ChatType,
  });
  const matchedSender = ownerState.explicitOwners.length
    ? senderCandidates.find((candidate) => ownerState.explicitOwners.includes(candidate))
    : undefined;
  const matchedCommandOwner = ownerState.commandOwnerCandidates.length
    ? senderCandidates.find((candidate) => ownerState.commandOwnerCandidates.includes(candidate))
    : undefined;
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

function captureCommandOwnerIdentity(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
  stateOptions: OpenClawStateDatabaseOptions,
  resolveProfile: (
    config: OpenClawConfig,
    identity: Parameters<typeof resolveChannelOperatorAdminAuthority>[1],
    options: OpenClawStateDatabaseOptions,
  ) =>
    | { profileId: string; isCurrent: (config: OpenClawConfig) => boolean; signal?: AbortSignal }
    | undefined,
): PreparedCommandOwnerAuthority {
  const captured = { ...requester };
  if (isConfiguredCommandOwner(cfg, captured)) {
    return Object.freeze({
      source: "configured-owner",
      isCurrent: (currentCfg: OpenClawConfig) => isConfiguredCommandOwner(currentCfg, captured),
    });
  }
  const providerId = normalizeAnyChannelId(captured.channel) ?? captured.channel;
  const authority =
    providerId && captured.senderId
      ? resolveProfile(
          cfg,
          {
            channelId: providerId,
            accountId: normalizeAccountId(captured.accountId),
            senderId: captured.senderId,
          },
          stateOptions,
        )
      : undefined;
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
  isCurrent: (currentCfg: OpenClawConfig) => boolean;
  /** The original additional person-policy grant, never a substitute for the current check. */
  signal?: AbortSignal;
  operator?: Awaited<ReturnType<typeof prepareChannelOperatorAuthority>>;
}>;

/** Worker admission fixes the original person; synchronous final checks never touch SQLite. */
export async function prepareCommandOwnerAuthority(
  cfg: OpenClawConfig,
  requester: { channel?: string; accountId?: string; senderId?: string },
  stateOptions: OpenClawStateDatabaseOptions = {},
): Promise<PreparedCommandOwnerAuthority> {
  const captured = { ...requester };
  const providerId = normalizeAnyChannelId(captured.channel) ?? captured.channel;
  const linked =
    providerId && captured.senderId
      ? await prepareChannelOperatorAuthority(
          cfg,
          {
            channelId: providerId,
            accountId: normalizeAccountId(captured.accountId),
            senderId: captured.senderId,
          },
          stateOptions,
        )
      : undefined;
  if (isConfiguredCommandOwner(cfg, captured)) {
    return Object.freeze({
      source: "configured-owner",
      operator: linked,
      isCurrent: (currentCfg: OpenClawConfig) => isConfiguredCommandOwner(currentCfg, captured),
    });
  }
  const prepared = linked?.scopes.includes("operator.admin") ? linked : undefined;
  return Object.freeze({
    source: prepared ? `profile:${prepared.profileId}` : undefined,
    operator: linked,
    ...(prepared?.signal ? { signal: prepared.signal } : {}),
    isCurrent: (currentCfg: OpenClawConfig) =>
      prepared !== undefined &&
      !isConfiguredCommandOwner(currentCfg, captured) &&
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

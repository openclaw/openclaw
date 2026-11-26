import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAllowFrom } from "../channels/account-resolution.js";
import {
  getLoadedChannelPluginById,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readCommandSenderAdmission } from "../gateway/operator-admission.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import {
  resolveConfiguredCommandOwners,
  resolveOwnerAllowFromList,
} from "./command-owner-facts.js";
import { getCommandSenderAuthority } from "./command-sender-authority.js";
import {
  formatAllowFromList,
  isWildcardAllowFromEntry,
  normalizeAllowFromEntry,
  resolveSenderCandidates,
  stripWildcardAllowFrom,
  type AllowFromParams,
} from "./sender-identity.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  /**
   * @deprecated Never set. The owner decision is fixed when the command is admitted; kept
   * only so published plugin SDK readers still compile. Remove with the next SDK break.
   */
  assertOwnerCurrent?: () => void;
  isAuthorizedSender: boolean;
  /** Retains command-policy admission independently of owner-only authority. */
  assertAuthorizedCurrent?: () => void;
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

function resolveExplicitProviderFromContext(
  ctx: MsgContext,
): { providerId: ChannelId | undefined; hadResolutionError: boolean } | undefined {
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
    normalizeAnyChannelId(explicitMessageChannel) ??
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
      normalizeAnyChannelId(normalizedCandidateChannel) ??
      (normalizedCandidateChannel as ChannelId | undefined) ??
      normalizeAnyChannelId(candidate);
    if (normalized) {
      return { providerId: normalized, hadResolutionError: false };
    }
  }
  return undefined;
}

function resolveInferredProvider(
  candidates: Array<{
    providerId: ChannelId;
    resolved: ReturnType<typeof resolveProviderAllowFrom>;
  }>,
): { providerId: ChannelId | undefined; hadResolutionError: boolean } {
  let droppedResolutionError = false;
  const inferredCandidates: ProviderResolution[] = [];
  for (const { providerId, resolved } of candidates) {
    if (resolved.allowFromList.length > 0) {
      inferredCandidates.push({
        providerId,
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

type ProviderAllowFromParams = AllowFromParams & {
  providerId?: ChannelId;
  forceFallbackResolutionError?: boolean;
};

type AllowFromResolutionResult = { value: unknown } | { error: unknown };

function resolveProviderAllowFromResult(
  params: ProviderAllowFromParams,
  result: AllowFromResolutionResult,
) {
  const { plugin, cfg, accountId } = params;
  // An unloaded channel has no trusted allowlist owner unless failed provider inference forces it.
  const providerId = params.forceFallbackResolutionError
    ? (params.providerId ?? plugin?.id)
    : plugin?.id;
  let hadResolutionError = Boolean(params.forceFallbackResolutionError);
  let allowFrom: Array<string | number>;
  if ("error" in result) {
    console.warn(
      `[command-auth] resolveAllowFrom threw for provider "${providerId}", falling back to config allowFrom: ${describeAllowFromResolutionError(result.error)}`,
    );
    hadResolutionError = true;
  } else if (result.value != null && !Array.isArray(result.value)) {
    console.warn(
      `[command-auth] resolveAllowFrom returned an invalid allowFrom for provider "${providerId}", falling back to config allowFrom: invalid_result`,
    );
    hadResolutionError = true;
  }
  if (hadResolutionError) {
    allowFrom = resolveFallbackAllowFrom({ cfg, providerId, accountId });
  } else {
    allowFrom = "value" in result && Array.isArray(result.value) ? result.value : [];
  }
  return {
    allowFromList: formatAllowFromList({ plugin, cfg, accountId, allowFrom }),
    hadResolutionError,
  };
}

function resolveProviderAllowFrom(params: ProviderAllowFromParams) {
  const { plugin, cfg, accountId } = params;
  let result: AllowFromResolutionResult;
  if (params.forceFallbackResolutionError || !plugin?.config?.resolveAllowFrom) {
    result = {
      value: resolveFallbackAllowFrom({
        cfg,
        providerId: params.forceFallbackResolutionError
          ? (params.providerId ?? plugin?.id)
          : plugin?.id,
        accountId,
      }),
    };
  } else {
    try {
      result = { value: plugin.config.resolveAllowFrom({ cfg, accountId }) };
    } catch (error) {
      result = { error };
    }
  }
  return resolveProviderAllowFromResult(params, result);
}

async function resolveProviderAllowFromAsync(params: ProviderAllowFromParams) {
  const { plugin, cfg, accountId } = params;
  if (params.forceFallbackResolutionError || !plugin) {
    return resolveProviderAllowFrom(params);
  }
  let result: AllowFromResolutionResult;
  try {
    result = {
      value:
        plugin.config.resolveAllowFromAsync || plugin.config.resolveAllowFrom
          ? await resolveChannelAllowFrom({ plugin, cfg, accountId })
          : resolveFallbackAllowFrom({ cfg, providerId: plugin.id, accountId }),
    };
  } catch (error) {
    result = { error };
  }
  return resolveProviderAllowFromResult(params, result);
}

function describeAllowFromResolutionError(err: unknown): string {
  return err instanceof Error ? (normalizeOptionalString(err.name) ?? "Error") : "unknown_error";
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

type CommandAuthorizationPreparation = {
  provider: { providerId: ChannelId | undefined; hadResolutionError: boolean };
  allowFrom: ReturnType<typeof resolveProviderAllowFrom>;
};

function resolveCommandAuthorizationState(
  params: CommandAuthorizationParams,
  prepared?: CommandAuthorizationPreparation,
): {
  authorization: CommandAuthorization;
  access: CommandSenderAccess;
  prepared: CommandAuthorizationPreparation;
} {
  const { ctx, cfg, commandAuthorized } = params;
  const { providerId, hadResolutionError: providerResolutionError } =
    prepared?.provider ??
    resolveExplicitProviderFromContext(ctx) ??
    resolveInferredProvider(
      listLoadedChannelPlugins().map((plugin) => ({
        providerId: plugin.id,
        resolved: resolveProviderAllowFrom({ plugin, cfg, accountId: ctx.AccountId }),
      })),
    );
  const plugin = providerId ? getLoadedChannelPluginById(providerId) : undefined;
  const from = normalizeOptionalString(ctx.From) ?? "";
  const to = normalizeOptionalString(ctx.To) ?? "";
  const commandsAllowFromConfigured = Boolean(
    cfg.commands?.allowFrom && typeof cfg.commands.allowFrom === "object",
  );

  const providerContext = { plugin, cfg, accountId: ctx.AccountId, providerId };
  const commandsAllowFrom = cfg.commands?.allowFrom;
  let commandsAllowFromList: string[] | null = null;
  if (commandsAllowFrom && typeof commandsAllowFrom === "object") {
    const providerList = commandsAllowFrom[providerId ?? ""];
    const globalList = commandsAllowFrom["*"];
    const rawList = Array.isArray(providerList) ? providerList : globalList;
    if (Array.isArray(rawList)) {
      commandsAllowFromList = formatAllowFromList({ ...providerContext, allowFrom: rawList });
    }
  }
  const resolvedAllowFrom =
    prepared?.allowFrom ??
    resolveProviderAllowFrom({
      ...providerContext,
      forceFallbackResolutionError: providerResolutionError,
    });
  const { allowFromList, hadResolutionError } = resolvedAllowFrom;
  const contextOwnerAllowFrom = ctx.OwnerAllowFrom;
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    ...providerContext,
    allowFrom: contextOwnerAllowFrom,
  });
  const allowAll =
    !hadResolutionError &&
    (allowFromList.length === 0 || allowFromList.some(isWildcardAllowFromEntry));
  const channelCommandOwners = allowAll ? [] : stripWildcardAllowFrom(allowFromList);
  if (!allowAll && channelCommandOwners.length === 0 && to) {
    channelCommandOwners.push(...normalizeAllowFromEntry({ ...providerContext, value: to }));
  }
  const explicitOwners = resolveConfiguredCommandOwners(cfg, {
    channel: providerId,
    accountId: ctx.AccountId,
  });
  const contextCommandOwners = stripWildcardAllowFrom(contextOwnerAllowFromList);
  // Channel and context lists can authorize commands within one transport, but only the global
  // owner list grants owner-only command and action authority.
  const commandOwnerCandidates = new Set(
    explicitOwners.length > 0
      ? explicitOwners
      : contextCommandOwners.length > 0
        ? contextCommandOwners
        : channelCommandOwners,
  );

  const senderCandidates = resolveSenderCandidates({
    ...providerContext,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    commandSenderId: getCommandSenderAuthority(ctx)?.(),
    from,
    chatType: ctx.ChatType,
  });
  const matchedCommandOwner = senderCandidates.find((candidate) =>
    commandOwnerCandidates.has(candidate),
  );
  const senderId = matchedCommandOwner ?? senderCandidates[0];

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
  // Trusted only as far as the internal Gateway provider is.
  const turnGrant = isInternalMessageChannel(ctx.Provider) ? ctx.TurnGrant : undefined;
  const ownerAllowlistConfigured = explicitOwners.length > 0;
  const senderIsOwner = readCommandSenderAdmission(ctx, explicitOwners, senderCandidates).grant
    .owner;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerAllowlistConfigured
      ? senderIsOwner
      : senderIsOwner || Boolean(matchedCommandOwner);
  // Literal turns cannot regain command access through an allowlist; inline
  // command consumers must preserve their text while owner facts remain intact.
  let access: CommandSenderAccess = "denied";
  if (ctx.CommandInterpretationSuppressed !== true && (!enforceOwner || isOwnerForCommands)) {
    if (
      commandsAllowFromList !== null ||
      (providerResolutionError && commandsAllowFromConfigured)
    ) {
      if (!providerResolutionError) {
        access =
          turnGrant?.commands === "all" ||
          commandsAllowFromList?.some(
            (entry) => isWildcardAllowFromEntry(entry) || senderCandidates.includes(entry),
          )
            ? "commands"
            : "denied";
      }
    } else if (commandAuthorized) {
      // Global ownership does not revoke channel-admitted session resets; explicit
      // channel owner enforcement and commands.allowFrom have already been applied.
      access = isOwnerForCommands ? "commands" : "reset-only";
    }
  }

  return {
    authorization: {
      providerId,
      ownerList: explicitOwners,
      senderId: senderId || undefined,
      senderIsOwner,
      isAuthorizedSender: access === "commands",
      from: from || undefined,
      to: to || undefined,
    },
    access,
    prepared: {
      provider: { providerId, hadResolutionError: providerResolutionError },
      allowFrom: resolvedAllowFrom,
    },
  };
}

function retainCommandAuthorization(
  params: CommandAuthorizationParams,
  prepared: CommandAuthorizationPreparation | undefined,
  readConfig: () => OpenClawConfig,
): CommandAuthorization {
  const captured = { ...params, ctx: { ...params.ctx }, cfg: readConfig() };
  const { authorization, prepared: admitted } = resolveCommandAuthorizationState(
    captured,
    prepared,
  );
  const plugin = authorization.providerId
    ? getLoadedChannelPluginById(authorization.providerId)
    : undefined;
  return {
    ...authorization,
    assertAuthorizedCurrent: () => {
      // Channel admission stays with its prepared worker/channel owner. Reuse
      // that fact while the command-policy owner evaluates the current config.
      const current = resolveCommandAuthorizationState(
        { ...captured, cfg: readConfig() },
        admitted,
      ).authorization;
      if (
        !authorization.isAuthorizedSender ||
        !current.isAuthorizedSender ||
        current.providerId !== authorization.providerId ||
        current.senderId !== authorization.senderId ||
        (authorization.providerId &&
          getLoadedChannelPluginById(authorization.providerId) !== plugin)
      ) {
        throw new Error("Your command authorization changed; send a new request.");
      }
    },
  };
}

/** @deprecated Await resolveCommandAuthorizationAsync for worker-owned channel allowlists. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveCommandAuthorization(
  params: CommandAuthorizationParams,
): CommandAuthorization {
  warnPluginSdkDeprecation({
    family: "command-authorization-sync",
    method: "resolveCommandAuthorization",
    replacement: "resolveCommandAuthorizationAsync",
  });
  return retainCommandAuthorization(params, undefined, createRuntimeConfigReader(params.cfg));
}

async function prepareCommandAuthorization(params: CommandAuthorizationParams) {
  const { ctx, cfg } = params;
  const provider =
    resolveExplicitProviderFromContext(ctx) ??
    resolveInferredProvider(
      await Promise.all(
        listLoadedChannelPlugins().map(async (plugin) => ({
          providerId: plugin.id,
          resolved: await resolveProviderAllowFromAsync({ plugin, cfg, accountId: ctx.AccountId }),
        })),
      ),
    );
  const plugin = provider.providerId ? getLoadedChannelPluginById(provider.providerId) : undefined;
  const allowFrom = await resolveProviderAllowFromAsync({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId: provider.providerId,
    forceFallbackResolutionError: provider.hadResolutionError,
  });
  return { provider, allowFrom };
}

/** Prepares channel allowlists through their worker-owned runtime before evaluating live authority. */
export async function resolveCommandAuthorizationAsync(
  params: CommandAuthorizationParams,
): Promise<CommandAuthorization> {
  const readConfig = createRuntimeConfigReader(params.cfg);
  const prepared = await prepareCommandAuthorization(params);
  return retainCommandAuthorization(params, prepared, readConfig);
}

/** Resolves reset admission without granting other command or owner authority. */
export async function isResetAuthorizedForContext(
  params: CommandAuthorizationParams,
): Promise<boolean> {
  const prepared = await prepareCommandAuthorization(params);
  return (
    resolveCommandAuthorizationState(params, prepared).access !== "denied" &&
    isResetAllowedForGatewayScopes(params.ctx)
  );
}

function isResetAllowedForGatewayScopes(ctx: MsgContext): boolean {
  const provider = ctx.Provider;
  const internalGatewayCaller = provider
    ? isInternalMessageChannel(provider)
    : isInternalMessageChannel(ctx.Surface);
  if (!internalGatewayCaller) {
    return true;
  }
  const scopes = ctx.GatewayClientScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return true;
  }
  return scopes.includes("operator.admin");
}

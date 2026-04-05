import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import type { MsgContext } from "./templating.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

type InferredProviderCandidate = {
  providerId: ChannelId;
  hadResolutionError: boolean;
};

type InferredProviderProbe = {
  candidates: InferredProviderCandidate[];
  droppedResolutionError: boolean;
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
  const inferred = inferredProviders.candidates;
  if (inferred.length === 1) {
    return {
      providerId: inferred[0].providerId,
      hadResolutionError: inferred[0].hadResolutionError,
    };
  }
  return {
    providerId: undefined,
    hadResolutionError:
      inferredProviders.droppedResolutionError ||
      inferred.some((entry) => entry.hadResolutionError),
  };
}

function probeInferredProviders(ctx: MsgContext, cfg: OpenClawConfig): InferredProviderProbe {
  let droppedResolutionError = false;
  const candidates = listChannelPlugins()
    .map((plugin) => {
      const resolvedAllowFrom = resolveProviderAllowFrom({
        plugin,
        cfg,
        accountId: ctx.AccountId,
      });
      const allowFrom = formatAllowFromList({
        plugin,
        cfg,
        accountId: ctx.AccountId,
        allowFrom: resolvedAllowFrom.allowFrom,
      });
      if (allowFrom.length === 0) {
        if (resolvedAllowFrom.hadResolutionError) {
          droppedResolutionError = true;
        }
        return null;
      }
      return {
        providerId: plugin.id,
        hadResolutionError: resolvedAllowFrom.hadResolutionError,
      };
    })
    .filter((value): value is InferredProviderCandidate => Boolean(value));
  return {
    candidates,
    droppedResolutionError,
  };
}

function formatAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (plugin?.config?.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return normalizeStringEntries(allowFrom);
}

function normalizeAllowFromEntry(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  value: string;
}): string[] {
  const normalized = formatAllowFromList({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: [params.value],
  });
  return normalized.filter((entry) => entry.trim().length > 0);
}

function resolveProviderAllowFrom(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): {
  allowFrom: Array<string | number>;
  hadResolutionError: boolean;
} {
  const { plugin, cfg, accountId } = params;
  const providerId = plugin?.id;
  if (!plugin?.config?.resolveAllowFrom) {
    return {
      allowFrom: resolveFallbackAllowFrom({ cfg, providerId, accountId }),
      hadResolutionError: false,
    };
  }

  try {
    const allowFrom = plugin.config.resolveAllowFrom({ cfg, accountId });
    if (allowFrom == null) {
      return {
        allowFrom: [],
        hadResolutionError: false,
      };
    }
    if (!Array.isArray(allowFrom)) {
      console.warn(
        `[command-auth] resolveAllowFrom returned an invalid allowFrom for provider "${providerId}", falling back to config allowFrom: invalid_result`,
      );
      return {
        allowFrom: resolveFallbackAllowFrom({ cfg, providerId, accountId }),
        hadResolutionError: true,
      };
    }
    return {
      allowFrom,
      hadResolutionError: false,
    };
  } catch (err) {
    console.warn(
      `[command-auth] resolveAllowFrom threw for provider "${providerId}", falling back to config allowFrom: ${describeAllowFromResolutionError(err)}`,
    );
    return {
      allowFrom: resolveFallbackAllowFrom({ cfg, providerId, accountId }),
      hadResolutionError: true,
    };
  }
}

function describeAllowFromResolutionError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name.trim();
    return name || "Error";
  }
  return "unknown_error";
}

function resolveOwnerAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  allowFrom?: Array<string | number>;
}): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const entry of raw) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex > 0) {
      const prefix = trimmed.slice(0, separatorIndex);
      const channel = normalizeAnyChannelId(prefix);
      if (channel) {
        if (params.providerId && channel !== params.providerId) {
          continue;
        }
        const remainder = trimmed.slice(separatorIndex + 1).trim();
        if (remainder) {
          filtered.push(remainder);
        }
        continue;
      }
    }
    filtered.push(trimmed);
  }
  return formatAllowFromList({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: filtered,
  });
}

/**
 * Resolves the commands.allowFrom list for a given provider.
 * Returns the provider-specific list if defined, otherwise the "*" global list.
 * Returns null if commands.allowFrom is not configured at all (fall back to channel allowFrom).
 */
function resolveCommandsAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
}): string[] | null {
  const { plugin, cfg, accountId, providerId } = params;
  const commandsAllowFrom = cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return null; // Not configured, fall back to channel allowFrom
  }

  // Check provider-specific list first, then fall back to global "*"
  const providerKey = providerId ?? "";
  const providerList = commandsAllowFrom[providerKey];
  const globalList = commandsAllowFrom["*"];

  const rawList = Array.isArray(providerList) ? providerList : globalList;
  if (!Array.isArray(rawList)) {
    return null; // No applicable list found
  }

  return formatAllowFromList({
    plugin,
    cfg,
    accountId,
    allowFrom: rawList,
  });
}

function isConversationLikeIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("@g.us")) {
    return true;
  }
  if (normalized.startsWith("chat_id:")) {
    return true;
  }
  return /(^|:)(channel|group|thread|topic|room|space|spaces):/.test(normalized);
}

function shouldUseFromAsSenderFallback(params: {
  from?: string | null;
  chatType?: string | null;
}): boolean {
  const from = (params.from ?? "").trim();
  if (!from) {
    return false;
  }
  const chatType = (params.chatType ?? "").trim().toLowerCase();
  if (chatType && chatType !== "direct") {
    return false;
  }
  return !isConversationLikeIdentity(from);
}

function resolveSenderCandidates(params: {
  plugin?: ChannelPlugin;
  providerId?: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
  from?: string | null;
  chatType?: string | null;
}): string[] {
  const { plugin, cfg, accountId } = params;
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
      return;
    }
    candidates.push(trimmed);
  };
  if (plugin?.commands?.preferSenderE164ForCommands) {
    pushCandidate(params.senderE164);
    pushCandidate(params.senderId);
  } else {
    pushCandidate(params.senderId);
    pushCandidate(params.senderE164);
  }
  if (
    candidates.length === 0 &&
    shouldUseFromAsSenderFallback({ from: params.from, chatType: params.chatType })
  ) {
    pushCandidate(params.from);
  }

  const normalized: string[] = [];
  for (const sender of candidates) {
    const entries = normalizeAllowFromEntry({ plugin, cfg, accountId, value: sender });
    for (const entry of entries) {
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
  }
  return normalized;
}

function resolveFallbackAllowFrom(params: {
  cfg: OpenClawConfig;
  providerId?: ChannelId;
  accountId?: string | null;
}): Array<string | number> {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return [];
  }
  const channels = params.cfg.channels as
    | Record<
        string,
        | {
            allowFrom?: Array<string | number>;
            dm?: { allowFrom?: Array<string | number> };
            accounts?: Record<
              string,
              {
                allowFrom?: Array<string | number>;
                dm?: { allowFrom?: Array<string | number> };
              }
            >;
          }
        | undefined
      >
    | undefined;
  const channelCfg = channels?.[providerId];
  const accountCfg =
    resolveFallbackAccountConfig(channelCfg?.accounts, params.accountId) ??
    resolveFallbackDefaultAccountConfig(channelCfg);
  const allowFrom =
    accountCfg?.allowFrom ??
    accountCfg?.dm?.allowFrom ??
    channelCfg?.allowFrom ??
    channelCfg?.dm?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : [];
}

function resolveFallbackAccountConfig(
  accounts:
    | Record<
        string,
        | {
            allowFrom?: Array<string | number>;
            dm?: { allowFrom?: Array<string | number> };
          }
        | undefined
      >
    | undefined,
  accountId?: string | null,
) {
  const normalizedAccountId = accountId?.trim().toLowerCase();
  if (!accounts || !normalizedAccountId) {
    return undefined;
  }
  const direct = accounts[normalizedAccountId];
  if (direct) {
    return direct;
  }
  const matchKey = Object.keys(accounts).find(
    (key) => key.trim().toLowerCase() === normalizedAccountId,
  );
  return matchKey ? accounts[matchKey] : undefined;
}

function resolveFallbackDefaultAccountConfig(
  channelCfg:
    | {
        allowFrom?: Array<string | number>;
        dm?: { allowFrom?: Array<string | number> };
        defaultAccount?: string;
        accounts?: Record<
          string,
          | {
              allowFrom?: Array<string | number>;
              dm?: { allowFrom?: Array<string | number> };
            }
          | undefined
        >;
      }
    | undefined,
) {
  const accounts = channelCfg?.accounts;
  if (!accounts) {
    return undefined;
  }
  const preferred =
    resolveFallbackAccountConfig(accounts, channelCfg?.defaultAccount) ??
    resolveFallbackAccountConfig(accounts, "default");
  if (preferred) {
    return preferred;
  }
  const definedAccounts = Object.values(accounts).filter(Boolean);
  return definedAccounts.length === 1 ? definedAccounts[0] : undefined;
}

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): CommandAuthorization {
  const { ctx, cfg, commandAuthorized } = params;
  const { providerId, hadResolutionError: providerResolutionError } = resolveProviderFromContext(
    ctx,
    cfg,
  );
  const plugin = providerId ? getChannelPlugin(providerId) : undefined;
  const from = (ctx.From ?? "").trim();
  const to = (ctx.To ?? "").trim();
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

  const resolvedAllowFrom = providerResolutionError
    ? {
        allowFrom: resolveFallbackAllowFrom({
          cfg,
          providerId,
          accountId: ctx.AccountId,
        }),
        hadResolutionError: true,
      }
    : resolveProviderAllowFrom({
        plugin,
        cfg,
        accountId: ctx.AccountId,
      });
  const allowFromList = formatAllowFromList({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    allowFrom: resolvedAllowFrom.allowFrom,
  });
  const configOwnerAllowFromList = resolveOwnerAllowFromList({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    allowFrom: cfg.commands?.ownerAllowFrom,
  });
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    plugin,
    cfg,
    accountId: ctx.AccountId,
    providerId,
    allowFrom: ctx.OwnerAllowFrom,
  });
  const allowAll =
    !resolvedAllowFrom.hadResolutionError &&
    (allowFromList.length === 0 || allowFromList.some((entry) => entry.trim() === "*"));

  const ownerCandidatesForCommands = allowAll ? [] : allowFromList.filter((entry) => entry !== "*");
  if (!allowAll && ownerCandidatesForCommands.length === 0 && to) {
    const normalizedTo = normalizeAllowFromEntry({
      plugin,
      cfg,
      accountId: ctx.AccountId,
      value: to,
    });
    if (normalizedTo.length > 0) {
      ownerCandidatesForCommands.push(...normalizedTo);
    }
  }
  const ownerAllowAll = configOwnerAllowFromList.some((entry) => entry.trim() === "*");
  const explicitOwners = configOwnerAllowFromList.filter((entry) => entry !== "*");
  const explicitOverrides = contextOwnerAllowFromList.filter((entry) => entry !== "*");
  const ownerList = Array.from(
    new Set(
      explicitOwners.length > 0
        ? explicitOwners
        : ownerAllowAll
          ? []
          : explicitOverrides.length > 0
            ? explicitOverrides
            : ownerCandidatesForCommands,
    ),
  );

  const senderCandidates = resolveSenderCandidates({
    plugin,
    providerId,
    cfg,
    accountId: ctx.AccountId,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    from,
    chatType: ctx.ChatType,
  });
  const matchedSender = ownerList.length
    ? senderCandidates.find((candidate) => ownerList.includes(candidate))
    : undefined;
  const matchedCommandOwner = ownerCandidatesForCommands.length
    ? senderCandidates.find((candidate) => ownerCandidatesForCommands.includes(candidate))
    : undefined;
  const senderId = matchedSender ?? senderCandidates[0];

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
  const senderIsOwnerByIdentity = Boolean(matchedSender);
  const senderIsOwnerByScope =
    isInternalMessageChannel(ctx.Provider) &&
    Array.isArray(ctx.GatewayClientScopes) &&
    ctx.GatewayClientScopes.includes("operator.admin");
  const ownerAllowlistConfigured = ownerAllowAll || explicitOwners.length > 0;
  const senderIsOwner = ctx.ForceSenderIsOwnerFalse
    ? false
    : senderIsOwnerByIdentity || senderIsOwnerByScope || ownerAllowAll;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerAllowAll
      ? true
      : ownerAllowlistConfigured
        ? senderIsOwner
        : allowAll || ownerCandidatesForCommands.length === 0 || Boolean(matchedCommandOwner);

  // If commands.allowFrom is configured, use it for command authorization
  // Otherwise, fall back to existing behavior (channel allowFrom + owner checks)
  let isAuthorizedSender: boolean;
  if (commandsAllowFromList !== null || (providerResolutionError && commandsAllowFromConfigured)) {
    // commands.allowFrom is configured - use it for authorization
    const commandsAllowAll =
      !providerResolutionError &&
      Boolean(commandsAllowFromList?.some((entry) => entry.trim() === "*"));
    const matchedCommandsAllowFrom = commandsAllowFromList?.length
      ? senderCandidates.find((candidate) => commandsAllowFromList.includes(candidate))
      : undefined;
    isAuthorizedSender =
      !providerResolutionError && (commandsAllowAll || Boolean(matchedCommandsAllowFrom));
  } else {
    // Fall back to existing behavior
    isAuthorizedSender = commandAuthorized && isOwnerForCommands;
  }

  return {
    providerId,
    ownerList,
    senderId: senderId || undefined,
    senderIsOwner,
    isAuthorizedSender,
    from: from || undefined,
    to: to || undefined,
  };
}

import type { ChannelDock } from "../channels/dock.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext } from "./templating.js";
import { getChannelDock, listChannelDocks } from "../channels/dock.js";
import { normalizeAnyChannelId } from "../channels/registry.js";

export type CommandAuthorization = {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
};

function resolveProviderFromContext(ctx: MsgContext, cfg: OpenClawConfig): ChannelId | undefined {
  const direct =
    normalizeAnyChannelId(ctx.Provider) ??
    normalizeAnyChannelId(ctx.Surface) ??
    normalizeAnyChannelId(ctx.OriginatingChannel);
  if (direct) {
    return direct;
  }
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalized = normalizeAnyChannelId(candidate);
    if (normalized) {
      return normalized;
    }
  }
  const configured = listChannelDocks()
    .map((dock) => {
      if (!dock.config?.resolveAllowFrom) {
        return null;
      }
      const allowFrom = dock.config.resolveAllowFrom({
        cfg,
        accountId: ctx.AccountId,
      });
      if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
        return null;
      }
      return dock.id;
    })
    .filter((value): value is ChannelId => Boolean(value));
  if (configured.length === 1) {
    return configured[0];
  }
  return undefined;
}

function formatAllowFromList(params: {
  dock?: ChannelDock;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  const { dock, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (dock?.config?.formatAllowFrom) {
    return dock.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeAllowFromEntry(params: {
  dock?: ChannelDock;
  cfg: OpenClawConfig;
  accountId?: string | null;
  value: string;
}): string[] {
  const normalized = formatAllowFromList({
    dock: params.dock,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: [params.value],
  });
  return normalized.filter((entry) => entry.trim().length > 0);
}

function resolveOwnerAllowFromList(params: {
  dock?: ChannelDock;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
}): string[] {
  const raw = params.cfg.commands?.ownerAllowFrom;
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
    dock: params.dock,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: filtered,
  });
}

function resolveSenderCandidates(params: {
  dock?: ChannelDock;
  providerId?: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
  from?: string | null;
}): string[] {
  const { dock, cfg, accountId } = params;
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
      return;
    }
    candidates.push(trimmed);
  };
  if (params.providerId === "whatsapp") {
    pushCandidate(params.senderE164);
    pushCandidate(params.senderId);
  } else {
    pushCandidate(params.senderId);
    pushCandidate(params.senderE164);
  }
  pushCandidate(params.from);

  const normalized: string[] = [];
  for (const sender of candidates) {
    const entries = normalizeAllowFromEntry({ dock, cfg, accountId, value: sender });
    for (const entry of entries) {
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
  }
  return normalized;
}

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): CommandAuthorization {
  const { ctx, cfg, commandAuthorized } = params;
  const providerId = resolveProviderFromContext(ctx, cfg);
  const dock = providerId ? getChannelDock(providerId) : undefined;
  const from = (ctx.From ?? "").trim();
  const to = (ctx.To ?? "").trim();
  const allowFromRaw = dock?.config?.resolveAllowFrom
    ? dock.config.resolveAllowFrom({ cfg, accountId: ctx.AccountId })
    : [];
  const allowFromList = formatAllowFromList({
    dock,
    cfg,
    accountId: ctx.AccountId,
    allowFrom: Array.isArray(allowFromRaw) ? allowFromRaw : [],
  });
  const ownerAllowFromList = resolveOwnerAllowFromList({
    dock,
    cfg,
    accountId: ctx.AccountId,
    providerId,
  });
  const allowAll =
    allowFromList.length === 0 || allowFromList.some((entry) => entry.trim() === "*");

  const ownerCandidatesForCommands = allowAll ? [] : allowFromList.filter((entry) => entry !== "*");
  if (!allowAll && ownerCandidatesForCommands.length === 0 && to) {
    const normalizedTo = normalizeAllowFromEntry({
      dock,
      cfg,
      accountId: ctx.AccountId,
      value: to,
    });
    if (normalizedTo.length > 0) {
      ownerCandidatesForCommands.push(...normalizedTo);
    }
  }
  const ownerAllowAll = ownerAllowFromList.some((entry) => entry.trim() === "*");
  const explicitOwners = ownerAllowFromList.filter((entry) => entry !== "*");
  const ownerList = Array.from(
    new Set(explicitOwners.length > 0 ? explicitOwners : ownerCandidatesForCommands),
  );

  const senderCandidates = resolveSenderCandidates({
    dock,
    providerId,
    cfg,
    accountId: ctx.AccountId,
    senderId: ctx.SenderId,
    senderE164: ctx.SenderE164,
    from,
  });
  const matchedSender = ownerList.length
    ? senderCandidates.find((candidate) => ownerList.includes(candidate))
    : undefined;
  const matchedCommandOwner = ownerCandidatesForCommands.length
    ? senderCandidates.find((candidate) => ownerCandidatesForCommands.includes(candidate))
    : undefined;
  const senderId = matchedSender ?? senderCandidates[0];

  const enforceOwner = Boolean(dock?.commands?.enforceOwnerForCommands);
  const senderIsOwner = Boolean(matchedSender);
  const ownerAllowlistConfigured = ownerAllowAll || explicitOwners.length > 0;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerAllowAll
      ? true
      : ownerAllowlistConfigured
        ? senderIsOwner
        : allowAll || ownerCandidatesForCommands.length === 0 || Boolean(matchedCommandOwner);
  const isAuthorizedSender = commandAuthorized && isOwnerForCommands;

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

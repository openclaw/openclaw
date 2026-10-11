import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../routing/session-key.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

function resolveScopedChannelCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeMessageChannel(value);
  if (!normalized || normalized === "all") {
    return undefined;
  }
  return normalized;
}

function resolveChannelFromTargetValue(target: unknown): string | undefined {
  const trimmed = normalizeOptionalString(target);
  if (!trimmed) {
    return undefined;
  }
  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const candidate = resolveScopedChannelCandidate(trimmed.slice(0, separator));
  if (!candidate || !isDeliverableMessageChannel(candidate)) {
    return undefined;
  }
  return candidate;
}

function resolveChannelFromTargets(targets: unknown): string | undefined {
  if (!Array.isArray(targets)) {
    return undefined;
  }
  const channels = new Set(
    targets.map(resolveChannelFromTargetValue).filter((channel) => channel !== undefined),
  );
  return channels.size === 1 ? [...channels][0] : undefined;
}

function resolveScopedAccountId(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return normalizeAccountId(trimmed);
}

export function resolveMessageSecretScope(params: {
  channel?: unknown;
  target?: unknown;
  targets?: unknown;
  fallbackChannel?: string | null;
  accountId?: unknown;
  fallbackAccountId?: string | null;
}): {
  channel?: string;
  accountId?: string;
} {
  const channel =
    resolveScopedChannelCandidate(params.channel) ??
    resolveChannelFromTargetValue(params.target) ??
    resolveChannelFromTargets(params.targets) ??
    resolveScopedChannelCandidate(params.fallbackChannel);

  const accountId =
    resolveScopedAccountId(params.accountId) ??
    resolveScopedAccountId(params.fallbackAccountId ?? undefined);

  return {
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

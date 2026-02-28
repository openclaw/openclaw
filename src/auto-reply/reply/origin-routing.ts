import type { OriginatingChannelType } from "../templating.js";
import type { FollowupRelayOutput } from "./queue/types.js";

function normalizeProviderValue(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeProviderValue(params.originatingChannel) ?? normalizeProviderValue(params.provider)
  );
}

export function resolveOriginMessageTo(params: {
  originatingTo?: string;
  to?: string;
}): string | undefined {
  return params.originatingTo ?? params.to;
}

export function resolveOriginAccountId(params: {
  originatingAccountId?: string;
  accountId?: string;
}): string | undefined {
  return params.originatingAccountId ?? params.accountId;
}

export function resolveRunDeliveryTarget(params: {
  relayMode?: "read-write" | "read-only";
  relayOutput?: FollowupRelayOutput;
  originatingChannel?: OriginatingChannelType;
  provider?: string;
  originatingTo?: string;
  to?: string;
  originatingAccountId?: string;
  accountId?: string;
  originatingThreadId?: string | number;
  threadId?: string | number;
}): {
  messageProvider?: string;
  messageTo?: string;
  accountId?: string;
  threadId?: string | number;
  viaRelayOutput: boolean;
} {
  const relayChannel = normalizeProviderValue(params.relayOutput?.channel);
  const relayTo = params.relayOutput?.to?.trim();
  if (params.relayMode === "read-only" && relayChannel && relayTo) {
    return {
      messageProvider: relayChannel,
      messageTo: relayTo,
      accountId: params.relayOutput?.accountId,
      threadId: params.relayOutput?.threadId,
      viaRelayOutput: true,
    };
  }

  return {
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.originatingChannel,
      provider: params.provider,
    }),
    messageTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
      to: params.to,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.originatingAccountId,
      accountId: params.accountId,
    }),
    threadId: params.originatingThreadId ?? params.threadId,
    viaRelayOutput: false,
  };
}

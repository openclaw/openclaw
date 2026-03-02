import type { OriginatingChannelType } from "../templating.js";

export type RunRelayMode = "read-write" | "read-only";

export type RunRelayOutput = {
  channel: OriginatingChannelType;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type RunDeliveryTarget = {
  relayMode: RunRelayMode;
  viaRelayOutput: boolean;
  channel?: OriginatingChannelType;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

function normalizeProviderValue(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeRelayMode(mode?: RunRelayMode): RunRelayMode {
  return mode === "read-only" ? "read-only" : "read-write";
}

function hasRelayOutput(relayOutput?: RunRelayOutput): relayOutput is RunRelayOutput {
  if (!relayOutput) {
    return false;
  }
  return Boolean(relayOutput.channel && relayOutput.to?.trim());
}

export function resolveRunDeliveryTarget(params: {
  relayMode?: RunRelayMode;
  relayOutput?: RunRelayOutput;
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): RunDeliveryTarget {
  const relayMode = normalizeRelayMode(params.relayMode);
  if (relayMode === "read-only") {
    if (!hasRelayOutput(params.relayOutput)) {
      return {
        relayMode,
        viaRelayOutput: false,
      };
    }
    return {
      relayMode,
      viaRelayOutput: true,
      channel: params.relayOutput.channel,
      to: params.relayOutput.to,
      accountId: params.relayOutput.accountId,
      threadId: params.relayOutput.threadId,
    };
  }
  return {
    relayMode,
    viaRelayOutput: false,
    channel: params.originatingChannel,
    to: params.originatingTo,
    accountId: params.originatingAccountId,
    threadId: params.originatingThreadId,
  };
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

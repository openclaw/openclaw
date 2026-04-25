import { normalizeProviderId } from "../agents/provider-id.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";

type ThinkingProviderPlugin = {
  id: string;
  aliases?: string[];
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  resolveDefaultThinkingLevel?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
};

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type ThinkingRegistryState = {
  activeRegistry?: {
    providers?: Array<{
      provider: ThinkingProviderPlugin;
    }>;
  } | null;
};

function matchesProviderId(provider: ThinkingProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalized);
}

function listActiveThinkingProviders(providerId: string): ThinkingProviderPlugin[] {
  const state = (
    globalThis as typeof globalThis & { [PLUGIN_REGISTRY_STATE]?: ThinkingRegistryState }
  )[PLUGIN_REGISTRY_STATE];
  return (
    state?.activeRegistry?.providers
      ?.filter((entry) => matchesProviderId(entry.provider, providerId))
      .map((entry) => entry.provider) ?? []
  );
}

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

export function resolveProviderBinaryThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  for (const provider of listActiveThinkingProviders(params.provider)) {
    const result = provider.isBinaryThinking?.(params.context);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

export function resolveProviderXHighThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  for (const provider of listActiveThinkingProviders(params.provider)) {
    const result = provider.supportsXHighThinking?.(params.context);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

export function resolveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  for (const provider of listActiveThinkingProviders(params.provider)) {
    const result = provider.resolveThinkingProfile?.(params.context);
    if (result !== undefined && result !== null) {
      return result;
    }
  }
  return undefined;
}

export function resolveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  for (const provider of listActiveThinkingProviders(params.provider)) {
    const result = provider.resolveDefaultThinkingLevel?.(params.context);
    if (result !== undefined && result !== null) {
      return result;
    }
  }
  return undefined;
}

import type { ProviderChannelLoginResolution } from "../../plugins/provider-login-options.js";
import { HostManagedProviderAuthError } from "../../shared/host-managed-auth-error.js";
import type { OpenClawConfig } from "../config-contracts.js";

/** Retains a synchronous ownership check for callers' credential and session write fences. */
export async function createProviderLoginAuthOwnershipGuard(params: {
  agentId: string;
  provider: string;
  modelId?: string;
  sessionKey?: string;
  runtimeId?: string;
}): Promise<(config: OpenClawConfig) => void> {
  const { resolveAgentHarnessAuthOwnership } =
    await import("../../agents/harness/auth-ownership.js");
  return (config) => {
    if (resolveAgentHarnessAuthOwnership({ ...params, config }) === "host") {
      throw new HostManagedProviderAuthError();
    }
  };
}

export async function createProviderLoginHostAuthResolver(params: {
  config: OpenClawConfig;
  agentId: string;
  currentProvider?: string;
  currentModelId?: string;
  currentRuntimeId?: string;
  sessionKey?: string;
}): Promise<(provider: string) => boolean> {
  const { resolveAgentHarnessAuthOwnership } =
    await import("../../agents/harness/auth-ownership.js");
  return (provider) =>
    resolveAgentHarnessAuthOwnership({
      config: params.config,
      agentId: params.agentId,
      provider,
      modelId: provider === params.currentProvider ? params.currentModelId : undefined,
      runtimeId: provider === params.currentProvider ? params.currentRuntimeId : undefined,
      sessionKey: params.sessionKey,
    }) === "host";
}

export function filterHostManagedProviderLoginChoices(
  resolution: ProviderChannelLoginResolution,
  isHostManaged: (provider: string) => boolean,
): ProviderChannelLoginResolution | undefined {
  if (resolution.status === "resolved" && isHostManaged(resolution.choice.providerId)) {
    return undefined;
  }
  if (resolution.status === "ambiguous" || resolution.status === "unsupported") {
    const choices = resolution.choices.filter((choice) => !isHostManaged(choice.providerId));
    return resolution.choices.length > 0 && choices.length === 0
      ? undefined
      : { ...resolution, choices };
  }
  if (resolution.status === "providers") {
    return {
      ...resolution,
      providers: resolution.providers.filter((provider) => !isHostManaged(provider.providerId)),
    };
  }
  return resolution;
}

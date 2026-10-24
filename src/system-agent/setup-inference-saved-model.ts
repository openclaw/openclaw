import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfigSnapshot,
} from "./inference-route.js";
import { parseInferenceRef } from "./setup-inference-core.js";

export async function resolveCurrentModelRefForSavedAuth(params: {
  config: OpenClawConfig;
  agentId?: string;
  credentialProvider: string;
  modelTarget: "primary" | "utility";
  configSnapshot?: SystemAgentConfigSnapshot;
}): Promise<string | undefined> {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    params.config,
    params.agentId,
    { modelTarget: params.modelTarget },
    params.configSnapshot,
  );
  const currentModelRef = route ? splitTrailingAuthProfile(route.modelLabel).model : "";
  if (!currentModelRef) {
    return undefined;
  }
  const currentProvider = resolveProviderIdForAuth(parseInferenceRef(currentModelRef).provider, {
    config: params.config,
  });
  const savedProvider = resolveProviderIdForAuth(params.credentialProvider, {
    config: params.config,
    storedCredential: true,
  });
  return currentProvider === savedProvider ? currentModelRef : undefined;
}

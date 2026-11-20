import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { resolveModelRuntimePolicy } from "../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import { prepareSetupModelRuntime } from "../../system-agent/setup-model-selection.js";

/**
 * What a login may save. A credential-only login keeps only credentials and provider settings,
 * plus the plugin's runtime choice when its caller asks for it. That choice applies only to the
 * agent's first login for the provider, judged from every profile it could use before this login,
 * inherited ones included: not just the one `--profile-id` names, and not what `--force` left.
 */
export function resolveLoginConnectionResult(
  result: ProviderAuthResult,
  login: {
    providerId: string;
    priorProfiles: Readonly<Record<string, AuthProfileCredential>>;
    credentialOnly?: boolean;
    keepAgentRuntime?: boolean;
  },
): ProviderAuthResult {
  const { agentRuntimeId, defaultModel, configPatch } = result;
  const firstLogin = !Object.values(login.priorProfiles).some(
    (credential) => credential.provider === login.providerId,
  );
  const runtime = agentRuntimeId && firstLogin ? { agentRuntimeId } : {};
  if (!login.credentialOnly) {
    const { agentRuntimeId: _choice, ...rest } = result;
    return { ...rest, ...runtime };
  }
  return {
    profiles: result.profiles,
    notes: result.notes,
    ...(configPatch
      ? {
          configPatch: {
            ...(configPatch.models?.providers
              ? { models: { providers: configPatch.models.providers } }
              : {}),
            ...(configPatch.plugins ? { plugins: configPatch.plugins } : {}),
          },
        }
      : {}),
    ...(login.keepAgentRuntime && runtime.agentRuntimeId && defaultModel
      ? { ...runtime, defaultModel }
      : {}),
  };
}

/** Routes a login's starter model through the runtime its provider chose, unless one is already set. */
export function applyLoginAgentRuntime(
  cfg: OpenClawConfig,
  login: { agentId: string; result: { agentRuntimeId?: string } },
  model: string | undefined,
): OpenClawConfig {
  const { agentId } = login;
  const agentRuntimeId = login.result.agentRuntimeId;
  if (!model || !agentRuntimeId) {
    return cfg;
  }
  if (resolveModelRuntimePolicy({ config: cfg, modelId: model, agentId }).policy) {
    return cfg;
  }
  return prepareSetupModelRuntime({ config: cfg, modelRef: model, agentId, agentRuntimeId }).config;
}

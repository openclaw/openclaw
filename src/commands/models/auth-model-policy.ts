import { resolveMutableAgentEntry } from "../../agents/agent-scope-config.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import {
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../../agents/model-selection-shared.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { logConfigUpdated } from "../../config/logging.js";
import { materializeModelPolicyAllowlist } from "../../config/model-policy-allowlist-migration.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyPrimaryModel } from "../../plugins/provider-model-primary.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ProviderAuthConfigApplyError } from "../../shared/provider-auth-result.js";
import { resolveModelsTargetAgent, updateConfig } from "./shared.js";

export function applyProviderLoginDefaultModel(
  config: OpenClawConfig,
  model: string,
): OpenClawConfig {
  const next = applyPrimaryModel(config, model);
  if (
    resolveConfiguredModelPolicyAllow({ cfg: config }).configPath ===
    LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH
  ) {
    next.agents ??= {};
    next.agents.defaults ??= {};
    next.agents.defaults.models = config.agents?.defaults?.models;
  }
  return next;
}

/** Provider setup defaults cannot change model restrictions; only saved credentials widen them. */
export function withoutProviderModelPolicy<T extends Pick<Partial<OpenClawConfig>, "agents">>(
  patch: T,
  config: OpenClawConfig,
): T {
  const connection = structuredClone(patch);
  if (connection.agents?.defaults) {
    delete connection.agents.defaults.modelPolicy;
    if (
      resolveConfiguredModelPolicyAllow({ cfg: config }).configPath ===
      LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH
    ) {
      delete connection.agents.defaults.models;
    }
  }
  for (const agent of Object.values(connection.agents?.entries ?? {})) {
    delete agent.modelPolicy;
  }
  return connection;
}

/** True when the allowlist names any model of the provider: the operator already chose those. */
function policyNamesProvider(config: OpenClawConfig, agentId: string, provider: string): boolean {
  // The policy owner resolves exact refs, aliases and bare legacy refs (from configured provider rows).
  const { allowedKeys } = createModelVisibilityPolicy({
    cfg: config,
    catalog: [],
    defaultProvider: DEFAULT_PROVIDER,
    agentId,
  });
  return [...allowedKeys].some((key) => normalizeProviderId(key.split("/")[0] ?? "") === provider);
}

/**
 * Saving credentials for a provider is the request to use its models: when an
 * allowlist hides every model of that provider, add `<provider>/*` to the
 * allowlist that governs the agent. Without an allowlist, or when the allowlist
 * already names some of the provider's models, nothing changes.
 */
export function allowProviderModelsInConfig(
  config: OpenClawConfig,
  agentId: string,
  providerId: string,
): string | undefined {
  const provider = normalizeProviderId(providerId);
  const wildcard = `${provider}/*`;
  const policy = resolveConfiguredModelPolicyAllow({ cfg: config, agentId });
  if (policy.refs.length === 0 || policyNamesProvider(config, agentId, provider)) {
    return undefined;
  }
  const allow = [...policy.refs, wildcard];
  if (policy.repairConfigPath === "agents.entries.*.modelPolicy.allow") {
    const agent = resolveMutableAgentEntry(config, agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" no longer exists.`);
    }
    agent.modelPolicy = { ...agent.modelPolicy, allow };
  } else {
    config.agents ??= {};
    config.agents.defaults ??= {};
    const defaults = config.agents.defaults;
    if (
      policy.configPath === LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH &&
      materializeModelPolicyAllowlist(config).kind === "deferred"
    ) {
      // An unmigrated legacy map stays the allowlist; a partial explicit policy would hide its models.
      defaults.models = { ...defaults.models, [wildcard]: {} };
    } else {
      defaults.modelPolicy = { ...defaults.modelPolicy, allow };
    }
  }
  return `Added ${wildcard} to allowed models.`;
}

export type ProviderModelAccess = { message: string; applied: boolean };

/** Applies {@link allowProviderModelsInConfig} after a sign-in saved provider credentials. */
async function allowProviderModels(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  runtime: RuntimeEnv;
  assertCurrent?: (config?: OpenClawConfig) => void;
}): Promise<ProviderModelAccess | undefined> {
  if (
    !allowProviderModelsInConfig(structuredClone(params.config), params.agentId, params.provider)
  ) {
    return undefined;
  }
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  let notice: string | undefined;
  await updateConfig(
    (config) => {
      params.assertCurrent?.(config);
      resolveModelsTargetAgent(config, params.agentId, { kind: "mutation" });
      notice = allowProviderModelsInConfig(config, params.agentId, params.provider);
      return config;
    },
    undefined,
    undefined,
    attachRuntimeConfigWriteApplication({ assertCurrent: params.assertCurrent }, application),
  );
  if (!notice) {
    return undefined;
  }
  const applied = application.claimed && (await application.result) === "applied";
  const message = applied
    ? notice
    : `${notice} OpenClaw has not confirmed it is active. Open Settings and select Apply changes, then send /models.`;
  logConfigUpdated(params.runtime);
  params.runtime.log(message);
  return { message, applied };
}

/** Sign-in variant: a failed policy write is reported as saved credentials with unapplied settings. */
export function allowLoginProviderModels(
  params: {
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
  agentId: string,
  provider: string,
): Promise<ProviderModelAccess | undefined> {
  return allowProviderModels({
    config: params.config,
    agentId,
    provider,
    runtime: params.runtime,
    assertCurrent: () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
    },
  }).catch((error: unknown) => {
    throw new ProviderAuthConfigApplyError(error);
  });
}

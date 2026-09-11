import { isDeepStrictEqual } from "node:util";
import { resolveMutableAgentEntry } from "../../agents/agent-scope-config.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import {
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../../agents/model-selection-shared.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import { materializeModelPolicyAllowlist } from "../../config/model-policy-allowlist-migration.js";
import { parseModelPolicyWildcardRef } from "../../config/model-policy-ref.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyDefaultModel } from "../../plugins/provider-auth-choice-helpers.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "../../wizard/prompts.js";
import { resolveModelsTargetAgent, updateConfig } from "./shared.js";

type ModelAccessChoice = "all" | "keep";

export function applyProviderLoginDefaultModel(
  config: OpenClawConfig,
  model: string,
): OpenClawConfig {
  const next = applyDefaultModel(config, model);
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

/** Provider setup defaults cannot supply consent to change model restrictions. */
export function withoutProviderModelPolicy(
  patch: Partial<OpenClawConfig>,
  config: OpenClawConfig,
): Partial<OpenClawConfig> {
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
  for (const agent of [
    ...Object.values(connection.agents?.entries ?? {}),
    ...(connection.agents?.list ?? []),
  ]) {
    delete agent.modelPolicy;
  }
  return connection;
}

function snapshotPolicy(config: OpenClawConfig, agentId: string) {
  const policy = resolveConfiguredModelPolicyAllow({ cfg: config, agentId });
  return {
    // Legacy allowlist materialization retains the same logical defaults owner.
    path: policy.configPath ? policy.repairConfigPath : null,
    refs: [
      ...new Set(
        policy.refs.map(
          (ref) => parseModelPolicyWildcardRef(ref)?.key ?? normalizeAgentModelRefForConfig(ref),
        ),
      ),
    ].toSorted(),
  };
}

export function prepareProviderModelAccess(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  providerLabel: string;
}) {
  const provider = normalizeProviderId(params.provider);
  const policy = snapshotPolicy(params.config, params.agentId);
  if (policy.refs.length === 0 || policy.refs.includes(`${provider}/*`)) {
    return undefined;
  }
  const prompt: WizardSelectParams<ModelAccessChoice> = {
    message: `Credentials saved. Your current model restrictions may hide ${params.providerLabel} models.`,
    initialValue: "keep",
    options: [
      { value: "all", label: `Show all ${params.providerLabel} models` },
      { value: "keep", label: "Keep current restrictions" },
    ],
  };
  return { provider, providerLabel: params.providerLabel, agentId: params.agentId, policy, prompt };
}

export async function completeProviderModelAccess(params: {
  prepared: ReturnType<typeof prepareProviderModelAccess>;
  prompter: Pick<WizardPrompter, "select">;
  runtime: RuntimeEnv;
  assertCurrent?: (config?: OpenClawConfig) => void;
  onRequested?: (request: PreparedProviderModelAccess) => void;
  beforeCommit?: () => void;
}): Promise<string> {
  const prepared = params.prepared;
  if (!prepared) {
    return "";
  }
  params.assertCurrent?.();
  if (params.onRequested) {
    params.onRequested(prepared);
    return "";
  }
  const choice = await params.prompter.select(prepared.prompt);
  params.assertCurrent?.();
  if (choice !== "all") {
    params.runtime.log("Credentials saved. Current model restrictions kept.");
    return "Current model restrictions kept.";
  }
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  await updateConfig(
    (config) => {
      params.assertCurrent?.(config);
      resolveModelsTargetAgent(config, prepared.agentId, { kind: "mutation" });
      if (!isDeepStrictEqual(snapshotPolicy(config, prepared.agentId), prepared.policy)) {
        throw new Error("Model restrictions changed during sign-in. Choose model access again.");
      }
      const policy = resolveConfiguredModelPolicyAllow({ cfg: config, agentId: prepared.agentId });
      const allow = [...policy.refs, `${prepared.provider}/*`];
      if (policy.repairConfigPath === "agents.entries.*.modelPolicy.allow") {
        const agent = resolveMutableAgentEntry(config, prepared.agentId);
        if (!agent) {
          throw new Error(`Agent "${prepared.agentId}" no longer exists.`);
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
          defaults.models = { ...defaults.models, [`${prepared.provider}/*`]: {} };
        } else {
          defaults.modelPolicy = { ...defaults.modelPolicy, allow };
        }
      }
      return config;
    },
    undefined,
    () => {
      params.assertCurrent?.();
      params.beforeCommit?.();
    },
    attachRuntimeConfigWriteApplication({}, application),
  );
  if (application.claimed && (await application.result) !== "applied") {
    throw new Error("The running Gateway did not apply the saved model restrictions.");
  }
  logConfigUpdated(params.runtime);
  const message = application.claimed
    ? `All ${prepared.providerLabel} models are now visible.`
    : "Model access saved. Application by the running Gateway is not confirmed. Run `openclaw gateway restart` to apply it.";
  params.runtime.log(`Credentials saved. ${message}`);
  return message;
}

export type PreparedProviderModelAccess = NonNullable<
  ReturnType<typeof prepareProviderModelAccess>
>;

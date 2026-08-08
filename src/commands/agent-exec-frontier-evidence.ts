import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  deriveFrontierEvidencePromptCacheKey,
  readFrontierEvidencePolicyFile,
  type FrontierEvidencePolicy,
} from "../agents/frontier-evidence-policy.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type FrontierEvidenceCliOptions = {
  authEnvOnly?: boolean;
  config?: string;
  fallback?: string[];
  frontierEvidencePolicy?: string;
  frontierEvidencePolicySha256?: string;
  frontierEvidenceRunNonce?: string;
  isolated?: boolean;
  model?: string;
  thinking?: string;
};

type FrontierEvidenceExecution = {
  policy: FrontierEvidencePolicy;
  authStore: AuthProfileStore;
  authProfileId: string;
  credentialEnvName: string;
  promptCacheKey: string;
};

export type FrontierEvidenceConfigSnapshot = {
  path: string;
  sha256: string;
};

export async function resolveFrontierEvidenceExecution(params: {
  baseConfig: OpenClawConfig;
  configSnapshot?: FrontierEvidenceConfigSnapshot;
  opts: FrontierEvidenceCliOptions;
}): Promise<FrontierEvidenceExecution | undefined> {
  const policyPath = params.opts.frontierEvidencePolicy?.trim();
  const policySha256 = params.opts.frontierEvidencePolicySha256?.trim();
  const runNonce = params.opts.frontierEvidenceRunNonce?.trim();
  if (!policyPath && !policySha256) {
    if (runNonce) {
      throw new Error("frontier evidence run nonce requires a frontier evidence policy");
    }
    return undefined;
  }
  if (!policyPath || !policySha256 || !params.opts.config || !runNonce) {
    throw new Error(
      "frontier evidence policy requires a pinned config, path, SHA-256, and run nonce",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(runNonce)) {
    throw new Error("frontier evidence run nonce must be 64 lowercase hex characters");
  }
  if (
    params.opts.isolated ||
    params.opts.authEnvOnly ||
    params.opts.model?.trim() ||
    (params.opts.fallback?.length ?? 0) > 0
  ) {
    throw new Error("frontier evidence policy conflicts with runtime route overrides");
  }

  const policy = await readFrontierEvidencePolicyFile({
    path: path.resolve(policyPath),
    expectedSha256: policySha256,
  });
  const configSnapshot = params.configSnapshot;
  if (
    !configSnapshot ||
    configSnapshot.path !== path.resolve(params.opts.config) ||
    configSnapshot.sha256 !== policy.configSha256
  ) {
    throw new Error("frontier evidence config SHA-256 mismatch");
  }

  const defaultAgentId = resolveDefaultAgentId(params.baseConfig);
  if (defaultAgentId !== policy.defaultAgentId) {
    throw new Error("frontier evidence default agent mismatch");
  }
  const configuredPrimary = resolveAgentEffectiveModelPrimary(params.baseConfig, defaultAgentId);
  const qualified = splitTrailingAuthProfile(configuredPrimary ?? "");
  if (qualified.model !== `${policy.provider}/${policy.model}` || !qualified.profile) {
    throw new Error("frontier evidence configured model/profile mismatch");
  }
  if (params.opts.thinking !== policy.thinking) {
    throw new Error("frontier evidence thinking level mismatch");
  }

  const credential = process.env[policy.credentialEnvName];
  if (!credential?.trim()) {
    throw new Error("frontier evidence credential environment is missing");
  }
  return {
    policy,
    authProfileId: qualified.profile,
    credentialEnvName: policy.credentialEnvName,
    promptCacheKey: deriveFrontierEvidencePromptCacheKey(policy.contentDigestKey, runNonce),
    authStore: {
      version: 1,
      profiles: {
        [qualified.profile]: {
          type: "api_key",
          provider: "openai",
          key: credential,
        },
      },
      order: { openai: [qualified.profile] },
      lastGood: { openai: qualified.profile },
    },
  };
}

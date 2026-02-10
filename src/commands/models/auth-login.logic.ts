import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { ProviderAuthResult, ProviderPlugin } from "../../plugins/types.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { upsertAuthProfile } from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { readConfigFileSnapshot, type OpenClawConfig } from "../../config/config.js";
import { resolvePluginProviders } from "../../plugins/providers.js";
import { applyAuthProfileConfig } from "../onboard-auth.js";
import { updateConfig } from "./shared.js";

// Helper Types
export type LoginResultHandlerParams = {
  result: ProviderAuthResult;
  agentDir: string;
  setDefault?: boolean;
};

// Pure logic for handling login results
export async function handleLoginResult(params: LoginResultHandlerParams) {
  const { result, agentDir, setDefault } = params;

  // 1. Save Profiles
  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });
  }

  // 2. Update Config
  await updateConfig((cfg) => {
    let next = cfg;
    if (result.configPatch) {
      next = mergeConfigPatch(next, result.configPatch);
    }
    for (const profile of result.profiles) {
      next = applyAuthProfileConfig(next, {
        profileId: profile.profileId,
        provider: profile.credential.provider,
        mode: credentialMode(profile.credential),
      });
    }
    if (setDefault && result.defaultModel) {
      next = applyDefaultModel(next, result.defaultModel);
    }
    return next;
  });
}

// Logic for resolving provider/method (non-interactive matching)
export function resolveLoginTarget(
  providers: ProviderPlugin[],
  opts: { provider?: string; method?: string },
) {
  const provider = resolveProviderMatch(providers, opts.provider);
  const method = provider ? pickAuthMethod(provider, opts.method) : null;
  return { provider, method };
}

// Logic for preparing environment
export async function prepareLoginEnv() {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error(`Invalid config at ${snapshot.path}`);
  }
  const config = snapshot.config;
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, defaultAgentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, defaultAgentId) ?? resolveDefaultAgentWorkspaceDir();
  const providers = resolvePluginProviders({ config, workspaceDir });

  return { config, agentDir, workspaceDir, providers };
}

// --- Helpers ---

function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const raw = rawProvider?.trim();
  if (!raw) {
    return null;
  }
  const normalized = normalizeProviderId(raw);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string) {
  const raw = rawMethod?.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase();
  return (
    provider.auth.find((method) => method.id.toLowerCase() === normalized) ??
    provider.auth.find((method) => method.label.toLowerCase() === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function applyDefaultModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};
  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}

export function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

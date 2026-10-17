import { vi } from "vitest";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
import {
  profileAuth,
  profileStore,
  requireFingerprint,
} from "./verified-inference.test-support.js";

export function configSnapshot(
  config: OpenClawConfig,
  overrides: Partial<ConfigFileSnapshot> = {},
): ConfigFileSnapshot {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    parsed: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

export function modelConfig(model = "openai/gpt-5.5"): OpenClawConfig {
  return { agents: { defaults: { model } } };
}

export function profileConfig(timeoutSeconds?: number): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
      },
    },
    auth: { profiles: { "openai:p2": { provider: "openai", mode: "api_key" } } },
  };
}

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
export function opsConfig(
  model: AgentEntry["model"],
  agentDir: string,
  extra: Partial<AgentEntry> = {},
): OpenClawConfig {
  return { agents: { defaults: {}, entries: { ops: { agentDir, model, ...extra } } } };
}

export async function createProfileInference(
  config: OpenClawConfig,
  owners = {
    resolveRoute: resolveSystemAgentConfiguredRouteFromConfig,
    createBinding: createSystemAgentVerifiedInferenceBinding,
  },
  agentHarnessId?: string,
) {
  const configuredRoute = await owners.resolveRoute(config);
  if (!configuredRoute) {
    throw new Error("missing test route");
  }
  const resolvedAuth = profileAuth("openai:p2", "test-key");
  const deps = {
    loadAuthProfileStoreForRuntimeAsync: profileStore("openai:p2", {
      type: "api_key",
      provider: "openai",
      key: "test-key",
    }),
    resolveApiKeyForProvider: vi.fn(async () => resolvedAuth),
  };
  const executionRoute = { ...configuredRoute, authProfileId: "openai:p2" };
  const binding = await owners.createBinding({
    configuredRoute,
    executionRoute,
    auth: {
      authProfileId: "openai:p2",
      authFingerprint: requireFingerprint(fingerprintResolvedProviderAuth(resolvedAuth)),
      ...(agentHarnessId ? { agentHarnessId } : {}),
      modelId: executionRoute.model,
      modelApi: "openai-responses",
    },
    deps,
  });
  return { binding, deps };
}

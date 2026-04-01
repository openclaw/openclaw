import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderReasoningOutputModeWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/types.js";

/**
 * Utility functions for provider-specific logic and capabilities.
 */

export function resolveReasoningOutputMode(params: {
  provider: string | undefined | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
}): "native" | "tagged" {
  const provider = params.provider?.trim();
  if (!provider) {
    return "native";
  }

  const pluginMode = resolveProviderReasoningOutputModeWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      model: params.model,
    },
  });
  if (pluginMode) {
    return pluginMode;
  }

  const normalized = provider.toLowerCase();

  // Check for exact matches or known prefixes/substrings for reasoning providers.
  // Note: Ollama is intentionally excluded - its OpenAI-compatible endpoint
  // handles reasoning natively via the `reasoning` field in streaming chunks,
  // so tag-based enforcement is unnecessary and causes all output to be
  // discarded as "(no output)" (#2279).
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return "tagged";
  }

  // Handle Minimax (M2.5 is chatty/reasoning-like)
  if (normalized.includes("minimax")) {
    return "tagged";
  }

  return "native";
}

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(
  provider: string | undefined | null,
  options?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    modelId?: string;
    modelApi?: string | null;
    model?: ProviderRuntimeModel;
  },
): boolean {
  return (
    resolveReasoningOutputMode({
      provider,
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      model: options?.model,
    }) === "tagged"
  );
}

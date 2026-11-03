/**
 * Provider behavior helpers shared by reply runners, embedded agents, and provider plugins.
 * Keep policy here generic; provider-specific reasoning rules belong in provider runtime hooks.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderReasoningOutputModeWithPlugin } from "../plugins/provider-runtime.js";

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
    runtimeHandle?: ProviderRuntimePluginHandle;
  },
): boolean {
  const normalizedProvider = normalizeOptionalString(provider);
  if (!normalizedProvider) {
    return false;
  }
  const { config, workspaceDir, env, runtimeHandle, modelId, modelApi, model } = options ?? {};
  // Provider hooks own model/API-specific reasoning transport rules.
  return (
    resolveProviderReasoningOutputModeWithPlugin({
      provider: normalizedProvider,
      config,
      workspaceDir,
      env,
      runtimeHandle,
      context: {
        config,
        workspaceDir,
        env,
        provider: normalizedProvider,
        modelId,
        modelApi,
        model,
      },
    }) === "tagged"
  );
}

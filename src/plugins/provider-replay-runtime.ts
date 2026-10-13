import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import {
  ensureProviderRuntimePluginHandle,
  resolveProviderRuntimePlugin,
  type ProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import type {
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderSanitizeReplayHistoryContextV2,
  ProviderValidateReplayTurnsContext,
} from "./provider-replay.types.js";

type ProviderReplayRuntimeLookup = Pick<
  Parameters<typeof resolveProviderRuntimePlugin>[0],
  "provider" | "config" | "workspaceDir" | "env"
>;

export async function sanitizeProviderReplayHistoryWithPluginAsync(
  params: ProviderReplayRuntimeLookup & { context: ProviderSanitizeReplayHistoryContextV2 },
) {
  const plugin = resolveProviderRuntimePlugin(params);
  if (plugin?.sanitizeReplayHistoryAsync) {
    return await plugin.sanitizeReplayHistoryAsync(params.context);
  }
  return undefined;
}

export async function validateProviderReplayTurnsWithPlugin(
  params: ProviderReplayRuntimeLookup & { context: ProviderValidateReplayTurnsContext },
): Promise<AgentMessage[] | null | undefined> {
  const plugin = resolveProviderRuntimePlugin(params);
  return await plugin?.validateReplayTurns?.(params.context);
}

export function resolveProviderReasoningOutputModeWithPlugin(
  params: ProviderReplayRuntimeLookup & {
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderReasoningOutputModeContext;
  },
): ProviderReasoningOutputMode | undefined {
  const mode = ensureProviderRuntimePluginHandle({
    ...params,
    modelId: params.context.modelId,
  }).plugin?.resolveReasoningOutputMode?.(params.context);
  return mode === "native" || mode === "tagged" ? mode : undefined;
}

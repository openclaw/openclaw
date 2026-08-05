import { loadAgentRuntimePluginRegistryHandle } from "../../agents/runtime-plugins.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronScheduledNativePolicy } from "../scheduled-native-policy.js";

export function resolveCronRuntimePluginRegistry(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  candidates: Array<{ provider: string; model: string }>;
  selectedCandidateIndex: number;
  scheduledNativePolicy?: CronScheduledNativePolicy;
  sessionEntry: SessionEntry;
  agentId: string;
}) {
  const candidates =
    params.selectedCandidateIndex >= 0
      ? params.candidates.slice(params.selectedCandidateIndex)
      : params.candidates;
  return loadAgentRuntimePluginRegistryHandle({
    config: params.config,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: true,
    selections: candidates.map((candidate) => {
      const runtime =
        params.scheduledNativePolicy?.mode === "disabled"
          ? "openclaw"
          : resolveSessionRuntimeOverrideForProvider({
              provider: candidate.provider,
              entry: params.sessionEntry,
              cfg: params.config,
            });
      return runtime
        ? {
            provider: candidate.provider,
            modelId: candidate.model,
            runtime,
            agentId: params.agentId,
          }
        : { provider: candidate.provider, modelId: candidate.model, agentId: params.agentId };
    }),
  });
}

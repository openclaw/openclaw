import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";

export type ModelFallbackParams = {
  provider?: string;
  model?: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  fallbacksOverride?: unknown[];
  requestedRouteResolution?: "raw" | "resolved";
  userLockedAuthProfileId?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  run: (
    provider: string,
    model: string,
    options: {
      allowTransientCooldownProbe?: boolean;
      isFinalFallbackAttempt?: boolean;
      modelRoutingProvenance: ModelFallbackAttemptProvenance;
    },
  ) => Promise<EmbeddedAgentRunResult>;
};

export function createMemoryRunEntryMockImplementation(deps: {
  runWithModelFallback: (params: ModelFallbackParams) => Promise<unknown>;
  ensureSelectedAgentHarnessPlugin: typeof ensureSelectedAgentHarnessPlugin;
}) {
  return async (params: Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0]) => {
    const assistantErrorTranscript = createAssistantErrorTranscript({
      runId: params.identity.runId,
    });
    const fallbackResult = (await deps.runWithModelFallback({
      ...params.selection,
      ...params.identity,
      abortSignal: params.abortSignal,
      resolveAgentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride,
      prepareAgentHarnessRuntime: async ({
        provider,
        model,
        agentHarnessRuntimeOverride,
      }: {
        provider: string;
        model: string;
        agentHarnessRuntimeOverride?: string;
      }) => {
        await deps.ensureSelectedAgentHarnessPlugin({
          config: params.selection.cfg,
          provider,
          modelId: model,
          agentId: params.identity.agentId,
          sessionKey: params.harness.sessionKey,
          agentHarnessId: agentHarnessRuntimeOverride,
          agentHarnessRuntimeOverride,
          workspaceDir: params.harness.workspaceDir,
          pluginRegistry: requireActivePluginRegistry(),
        });
      },
      run: (provider: string, model: string, options: Parameters<ModelFallbackParams["run"]>[2]) =>
        params.runCandidate(provider, model, {
          agentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride(provider, model),
          assistantErrorTranscript,
          classifyResult: () => undefined,
          allowTransientCooldownProbe: options.allowTransientCooldownProbe,
          isFinalFallbackAttempt: options.isFinalFallbackAttempt,
          isFallbackRetry: false,
          modelRoutingProvenance: options.modelRoutingProvenance,
          contextEngineLogicalTurnLease: {} as never,
          onContextEngineTurnCandidate: () => {},
        }),
    })) as {
      outcome?: "completed" | "exhausted";
      result: EmbeddedAgentRunResult;
      provider: string;
      model: string;
      attempts: [];
    };
    return {
      ...fallbackResult,
      outcome: fallbackResult.outcome ?? ("completed" as const),
      terminal: {
        outcome: { reason: "completed" as const, status: "ok" as const },
        metadata: {},
      },
      settleSessionOverride: async () => undefined,
    };
  };
}

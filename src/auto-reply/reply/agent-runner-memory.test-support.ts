import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { MemoryFlushPlan } from "../../plugins/registry-contribution-types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";

export type { RunEmbeddedAgentInternalParams as EmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
export type { CompactEmbeddedAgentSessionRuntimeParams as CompactEmbeddedAgentSessionParams } from "../../agents/embedded-agent-runner/compact.types.js";

export async function seedMemoryAccountingTranscript(
  scope: SessionTranscriptRuntimeTarget,
  workspaceDir: string,
  { customTail, newUser }: { customTail: number; newUser: boolean },
): Promise<void> {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  const transcript = SessionManager.open(scope, workspaceDir);
  const user = {
    role: "user" as const,
    content: "Research this",
    timestamp: 1,
    __openclaw: { senderIsOwner: true },
  };
  transcript.appendMessage(user);
  const networkResult = {
    role: "toolResult" as const,
    toolCallId: "network-read",
    toolName: "read",
    isError: false,
    content: [{ type: "text" as const, text: "untrusted page" }],
    timestamp: 2,
    __openclaw: { resultContentSource: "network" as const },
  };
  transcript.appendMessage(networkResult);
  const answer = {
    ...makeAssistantMessageFixture({
      content: [{ type: "text", text: "network-derived answer" }],
      stopReason: "stop",
      errorMessage: undefined,
    }),
    usage: {
      ...makeAssistantMessageFixture().usage,
      input: 78_000,
      output: 100,
      totalTokens: 78_100,
    },
  };
  transcript.appendMessage(answer);
  if (newUser) {
    transcript.appendMessage({ ...user, content: "Save my own notes", timestamp: 3 });
  }
  // The bounded case loses the original turn marker across this tail.
  for (let index = 0; index < customTail; index += 1) {
    transcript.appendCustomEntry("fixture-tail", { index });
  }
}

type FileFlushPlan = Extract<MemoryFlushPlan, { relativePath: string }>;

export function createMemoryFlushPlan(): FileFlushPlan {
  return {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2023-11-14.md",
  };
}

export function createModifiedMemoryFlushPlan(overrides: Partial<FileFlushPlan>): MemoryFlushPlan {
  return { ...createMemoryFlushPlan(), ...overrides };
}

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
    const assistantErrorTranscript = createAssistantErrorTranscript();
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

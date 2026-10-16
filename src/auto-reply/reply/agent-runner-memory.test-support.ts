import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ModelFallbackRunOptions } from "../../agents/model-fallback-attempt.js";
import type { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { MemoryFlushPlan } from "../../plugins/registry-contribution-types.js";

export type { RunEmbeddedAgentInternalParams as EmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
export type { CompactEmbeddedAgentSessionRuntimeParams as CompactEmbeddedAgentSessionParams } from "../../agents/embedded-agent-runner/compact.types.js";

export function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: Date.now(), ...overrides };
}

export function createFreshSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return createSessionEntry({ totalTokensFresh: true, totalTokensVersion: 1, ...overrides });
}

export function createFlushSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return createFreshSessionEntry({ totalTokens: 80_000, compactionCount: 1, ...overrides });
}

export function modelRoutingProvenance(
  requestedProvider: string,
  requestedModel: string,
  stage: ModelFallbackAttemptProvenance["stage"] = "initial",
): ModelFallbackAttemptProvenance {
  return { requestedProvider, requestedModel, stage };
}

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
  transcript.appendMessage({
    role: "toolResult",
    toolCallId: "network-read",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: "untrusted page" }],
    timestamp: 2,
    __openclaw: { resultContentSource: "network" },
  });
  transcript.appendMessage(
    makeAssistantMessageFixture({
      content: [{ type: "text", text: "network-derived answer" }],
      stopReason: "stop",
      errorMessage: undefined,
      usage: {
        ...makeAssistantMessageFixture().usage,
        input: 78_000,
        output: 100,
        totalTokens: 78_100,
      },
    }),
  );
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

export type ModelFallbackParams = Omit<
  Parameters<typeof runWithModelFallback<EmbeddedAgentRunResult>>[0],
  "run"
> & {
  run: (
    provider: string,
    model: string,
    options: ModelFallbackRunOptions,
  ) => Promise<EmbeddedAgentRunResult>;
};

export async function runInitialMemoryFallback({ provider, model, run }: ModelFallbackParams) {
  return {
    result: await run(provider, model, {
      modelRoutingProvenance: modelRoutingProvenance(provider, model),
    }),
    provider,
    model,
    attempts: [],
  };
}

type MemoryFallbackResult = Awaited<ReturnType<typeof runInitialMemoryFallback>> & {
  outcome?: "completed" | "exhausted";
};

export function createMemoryRunEntryMockImplementation(
  runWithModelFallback: (params: ModelFallbackParams) => Promise<MemoryFallbackResult>,
) {
  return async (params: Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0]) => {
    const assistantErrorTranscript = createAssistantErrorTranscript();
    const fallbackResult = await runWithModelFallback({
      ...params.selection,
      ...params.identity,
      abortSignal: params.abortSignal,
      run: (provider, model, options) =>
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
    });
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

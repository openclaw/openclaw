import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentMeta } from "../../agents/embedded-agent-runner/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";
import type {
  AgentTurnCompaction,
  AgentTurnExecutionResult,
} from "./agent-runner-execution.types.js";
import { accountAgentTurn, accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import {
  createReplyOperation,
  retainReplyOperationUntilComplete,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const diagnostic = {
  schemaVersion: 1,
  source: "pre-prompt-estimate",
  updatedAt: 20,
  provider: "openai",
  model: "gpt-5.6-luna",
  route: "compact_only",
  shouldCompact: true,
  estimatedPromptTokens: 950,
  contextTokenBudget: 1_000,
  promptBudgetBeforeReserve: 900,
  reserveTokens: 100,
  effectiveReserveTokens: 100,
  remainingPromptBudgetTokens: 0,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  messageCount: 4,
  unwindowedMessageCount: 4,
} satisfies NonNullable<SessionEntry["contextBudgetStatus"]>;

export { diagnostic as agentAccountingPersistenceDiagnostic };

export async function createAgentAccountingPersistenceFixture({
  storePath,
  root,
  fixtureId,
  registerOperation,
}: {
  storePath: string;
  root: string;
  fixtureId: number;
  registerOperation: (operation: ReplyOperation) => void;
}) {
  const sessionKey = `agent:main:accounting-${fixtureId}`;
  const sessionId = `accounting-session-${fixtureId}`;
  const runId = `context-pressure-run-${fixtureId}`;
  const entry: InternalSessionEntry = {
    sessionId,
    lifecycleRevision: "generation-1",
    activeWriterRunId: runId,
    updatedAt: 1,
    modelProvider: diagnostic.provider,
    model: diagnostic.model,
    contextBudgetStatus: { ...diagnostic, updatedAt: 1 },
    estimatedCostUsd: 2,
  };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    models: {
      providers: {
        openai: {
          baseUrl: "https://unused.invalid",
          models: [
            {
              id: diagnostic.model,
              name: "test model",
              reasoning: false,
              input: ["text"],
              contextWindow: 1_000,
              maxTokens: 100,
              cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
            },
          ],
        },
      },
    },
  };
  const followupRun = createMockFollowupRun({
    run: {
      sessionKey,
      sessionId: entry.sessionId,
      agentDir: root,
      workspaceDir: root,
      config: cfg,
      provider: diagnostic.provider,
      model: diagnostic.model,
    },
  });
  const sessionStore = { [sessionKey]: entry };
  const replyOperation = createReplyOperation({
    sessionId: entry.sessionId,
    sessionKey,
    resetTriggered: false,
  });
  replyOperation.setPhase("running");
  retainReplyOperationUntilComplete(replyOperation);
  registerOperation(replyOperation);
  const context: FinalizeReplyAgentRunInput & { storePath: string } = {
    activeIsNewSession: false,
    activeSessionEntry: entry,
    activeSessionStore: sessionStore,
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    cfg,
    commandBody: followupRun.prompt,
    defaultModel: diagnostic.model,
    followupRun,
    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    queueKey: sessionKey,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyOperation,
    replyRouteThreadId: undefined,
    replyToChannel: undefined,
    replyToMode: "off",
    resolvedBlockStreamingBreak: "message_end",
    resolvedQueue: { mode: "followup" },
    resolvedVerboseLevel: "off",
    returnWithQueuedFollowupDrain: (value) => value,
    runFollowupTurn: async () => {},
    execution: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 1,
          requestShaping: { authMode: "api-key", fallbackEligible: false },
        },
      },
      resolved: {
        provider: diagnostic.provider,
        model: diagnostic.model,
      },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
    runId,
    runStartedAt: Date.now(),
    sessionCtx: {},
    sessionKey,
    shouldInjectGroupIntro: false,
    storePath,
    typingSignals: createTypingSignaler({
      typing: createMockTypingController(),
      mode: "never",
    }),
  };
  const handle = createReplySessionEntryHandle({
    sessionEntry: entry,
    sessionStore,
    sessionKey,
    generationFence: { sessionId: entry.sessionId, expectedStoreEntry: entry },
  });
  const turn: AdmittedFollowupTurn = {
    runId: context.runId,
    queued: followupRun,
    operation: context.replyOperation,
    config: cfg,
    session: {
      kind: "session",
      key: sessionKey,
      storePath,
      current: () => handle.getCurrent(),
      publish: (next) => next && handle.replaceCurrent(next),
      adopt: (next) => handle.adoptCurrent(next),
    },
    sessionStore: handle.toCompatSessionStore(),
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
  const withCompletion = <T>(
    consume: (completion: AgentTurnCompletion | undefined) => Promise<T>,
  ) =>
    withAgentTurnCompletion(
      {
        agentId: "main",
        storePath,
        sessionKey,
        entry: context.activeSessionEntry,
        operation: replyOperation,
        publish(next) {
          context.activeSessionEntry = next;
          sessionStore[sessionKey] = next;
          turn.session.publish(next);
        },
      },
      consume,
    );
  const accountQueued = (
    outcome: AgentTurnExecutionResult["outcome"],
    completion?: AgentTurnCompletion,
  ) =>
    accountFollowupTurn({
      turn,
      completion,
      defaults: {
        defaultModel: diagnostic.model,
        typing: createMockTypingController(),
        typingMode: "never",
      },
      execution: {
        commentaryPayloadsEnabled: false,
        execution: { runId: context.runId, outcome },
        runStartedAt: context.runStartedAt,
        sessionCtx: {},
        pendingToolTasks: context.pendingToolTasks,
        progress: { drain: async () => {} },
      },
    });
  const recordCompaction = (params: { sessionId?: string; currentContextTokens?: number } = {}) => {
    const fact: CompactionAccountingFact = {
      kind: "durable",
      count: 1,
      currentContextSnapshot: { tokens: params.currentContextTokens },
      target: {
        agentId: "main",
        sessionKey,
        storePath,
        sessionId: params.sessionId ?? entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
    };
    const compaction: AgentTurnCompaction = { count: fact.count, durable: [fact] };
    context.execution.autoCompactionCount = compaction.count;
    context.execution.compaction = compaction;
    return compaction;
  };
  return {
    sessionId,
    context,
    turn,
    withCompletion,
    deliverQueued: async () => {
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: "synthetic",
        source: "test",
        provider: {
          id: diagnostic.provider,
          label: "Synthetic provider",
          auth: [],
        },
      });
      return withPluginRuntimeRegistryScope(registry, async () => {
        const delivered: ReplyPayload[] = [];
        const decision = await withCompletion(async (completion) => {
          const accounting = await accountQueued(context.execution, completion);
          const resolved = await resolveFollowupDeliveryDecision({
            turn,
            execution: { runId: context.runId, outcome: context.execution },
            accounting,
            opts: { onBlockReply: async () => {} },
          });
          await completion?.complete();
          return resolved;
        });
        await deliverFollowupDecision({
          decision,
          turn,
          defaults: {
            defaultModel: diagnostic.model,
            typing: createMockTypingController(),
            typingMode: "never",
            opts: {
              onBlockReply: async (payload) => {
                delivered.push(payload);
              },
            },
          },
          runId: context.runId,
          runFollowup: async () => {},
        });
        return delivered;
      });
    },
    recordCompaction,
    accountAborted: (reason: "user" | "restart") => {
      const compaction =
        context.execution.compaction ?? recordCompaction({ currentContextTokens: 40 });
      if (reason === "restart") {
        replyOperation.abortForRestart();
      } else {
        replyOperation.abortByUser();
      }
      return accountQueued({ kind: "aborted", reason, compaction });
    },
    read: () => loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
    replace: (next: InternalSessionEntry) => replaceSessionEntry({ storePath, sessionKey }, next),
    account: async (lane: "ordinary" | "followup", meta: Partial<EmbeddedAgentMeta>) => {
      context.execution.result.meta.agentMeta = {
        sessionId: entry.sessionId,
        provider: diagnostic.provider,
        model: diagnostic.model,
        contextTokens: 1_000,
        contextBudgetStatus: diagnostic,
        ...meta,
      };
      if (lane === "ordinary") {
        await withCompletion(async (completion) => {
          const current = { ...context, completion };
          const accounting = await accountAgentTurn(current);
          await completeReplyAgentRun({
            context: current,
            accounting,
            prepared: {
              kind: "continue",
              activeSessionEntry: accounting.activeSessionEntry,
              // The reply was already delivered; exercise completion bookkeeping
              // without creating another pending delivery intent.
              completedSourceReplyDelivery: true,
              guardedReplyPayloads: [],
              responseUsageLine: undefined,
            },
          });
        });
      } else {
        turn.preflightCompactionApplied = context.preflightCompactionApplied === true;
        await withCompletion((completion) => accountQueued(context.execution, completion));
      }
    },
  };
}

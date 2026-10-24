import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentMeta } from "../../agents/embedded-agent-runner/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";
import type {
  AgentTurnCompaction,
  AgentTurnExecutionResult,
} from "./agent-runner-execution.types.js";
import { accountAgentTurn, accountFollowupTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { createReplyParams } from "./agent-runner-steer-adoption.test-support.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
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

export function withAccountingProvider<T>(run: () => T): T {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "synthetic",
    source: "test",
    provider: { id: diagnostic.provider, label: "Synthetic provider", auth: [] },
  });
  return withPluginRuntimeRegistryScope(registry, run);
}

export function createTestFinalizationContext(
  followupRun: FinalizeReplyAgentRunInput["followupRun"],
  replyOperation: ReplyOperation,
): FinalizeReplyAgentRunInput {
  const { config: cfg, model, provider, sessionKey } = followupRun.run;
  const reply = createReplyParams(followupRun, {
    transcriptCommandBody: undefined,
    queueKey: sessionKey ?? "test",
    resolvedQueue: { mode: "followup" },
  });
  return {
    ...reply,
    activeIsNewSession: false,
    activeSessionEntry: undefined,
    activeSessionStore: {},
    blockReplyPipeline: null,
    cfg,

    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyOperation,
    replyRouteThreadId: undefined,
    replyToChannel: undefined,
    replyToMode: "off",
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
      resolved: { provider, model },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
    },
    runId: "test-run",
    runStartedAt: Date.now(),
    typingSignals: createTypingSignaler({
      typing: reply.typing,
      mode: "never",
    }),
  };
}

export async function createAgentAccountingPersistenceFixture({
  storePath,
  root,
  fixtureId,
  incognito = false,
  registerOperation,
}: {
  storePath: string;
  root: string;
  fixtureId: number;
  incognito?: boolean;
  registerOperation: (operation: ReplyOperation) => void;
}) {
  const sessionKey = incognito
    ? `agent:main:dashboard:incognito-accounting-${fixtureId}`
    : `agent:main:accounting-${fixtureId}`;
  const sessionId = `accounting-session-${fixtureId}`;
  const runId = `context-pressure-run-${fixtureId}`;
  const entry: InternalSessionEntry = {
    sessionId,
    ...(incognito ? { incognito: true } : {}),
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
  registerOperation(replyOperation);
  const context: FinalizeReplyAgentRunInput & { storePath: string } = {
    ...createTestFinalizationContext(followupRun, replyOperation),
    activeSessionEntry: entry,
    activeSessionStore: sessionStore,
    runId,
    storePath,
  };
  const handle = createReplySessionEntryHandle({
    sessionEntry: entry,
    sessionStore,
    sessionKey,
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
  const defaults = {
    defaultModel: diagnostic.model,
    typing: createMockTypingController(),
    typingMode: "never" as const,
  };
  const accountQueued = (
    outcome: AgentTurnExecutionResult["outcome"],
    completion?: AgentTurnCompletion,
  ) =>
    accountFollowupTurn({
      turn,
      completion,
      defaults,
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
  const setMeta = (meta: Partial<EmbeddedAgentMeta>) => {
    context.execution.result.meta.agentMeta = {
      sessionId: entry.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      ...meta,
    };
  };
  const read = () => loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  const replace = (next: InternalSessionEntry) =>
    replaceSessionEntry({ storePath, sessionKey }, next);
  return {
    sessionId,
    context,
    turn,
    withCompletion,
    setMeta,
    deliverQueued: async () =>
      withAccountingProvider(async () => {
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
            ...defaults,
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
      }),
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
    read,
    replace,
    patch: async (patch: Partial<InternalSessionEntry>) => {
      const next = { ...read()!, ...patch };
      await replace(next);
      return next;
    },
    account: async (lane: "ordinary" | "followup", meta: Partial<EmbeddedAgentMeta>) => {
      setMeta({ contextTokens: 1_000, contextBudgetStatus: diagnostic, ...meta });
      if (lane === "ordinary") {
        await withCompletion(async (completion) => {
          await accountAgentTurn({ ...context, completion });
          await completion?.complete();
        });
      } else {
        turn.preflightCompactionApplied = context.preflightCompactionApplied === true;
        await withCompletion((completion) => accountQueued(context.execution, completion));
      }
    },
  };
}

export function observeCompletionCommands(
  options: {
    hideCommittedReceipt?: boolean;
    lostReplyError?: Error;
    beforeCommit?: () => void;
    afterRead?: () => void | Promise<void>;
  } = {},
) {
  const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
  const commands: string[] = [];
  const execution = vi
    .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const owner = capture(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, run, runOptions) =>
          owner.runExisting(
            source,
            (worker) =>
              run({
                execute(command, commandOptions) {
                  commands.push(command.type);
                  const result = worker.execute(command, commandOptions);
                  const lostReplyError = options.lostReplyError;
                  if (lostReplyError && command.type !== "session.actor.read") {
                    // Lose only the response after the real worker has completed its write.
                    return result.then(() => {
                      throw lostReplyError;
                    });
                  }
                  return command.type === "session.actor.read" && options.afterRead
                    ? result.then(async (value) => {
                        await options.afterRead?.();
                        return value;
                      })
                    : result;
                },
              }),
            runOptions,
          ),
      };
    });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((authorize, attachment) => {
      let terminalCommit = false;
      const owner = createAdmission((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-actor-admission" &&
          request.facts.publication.final === true
        ) {
          terminalCommit = true;
          options.beforeCommit?.();
        }
        return authorize(request, grant);
      }, attachment);
      if (options.hideCommittedReceipt) {
        const committed = Object.getOwnPropertyDescriptor(owner, "committed")!;
        Object.defineProperty(owner, "committed", {
          get() {
            const receipt = committed.get!.call(owner);
            return terminalCommit ? undefined : receipt;
          },
        });
      }
      return owner;
    });
  return {
    commands,
    restore() {
      admission.mockRestore();
      execution.mockRestore();
    },
  };
}

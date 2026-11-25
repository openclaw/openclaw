import type { WorkerToolSurface } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agents/agent-project-settings.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { prepareEmbeddedAttemptBootstrap } from "../../agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "../../agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import { prepareAttemptSystemPromptAdditions } from "../../agents/embedded-agent-runner/run/attempt-system-prompt-additions.js";
import { prepareEmbeddedAttemptSystemPrompt } from "../../agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js";
import { resolveExistingAttemptTranscriptState } from "../../agents/embedded-agent-runner/run/attempt-transcript-helpers.js";
import {
  beginSessionSystemPrompt,
  buildSystemPromptRouteKey,
  createToolResultPromptProjectionState,
  persistSessionSystemPrompt,
  prepareSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { retireUserRowPromptUpdates } from "../../agents/embedded-agent-runner/session-prompt-update.js";
import {
  prepareHarnessContextEnginePrompt,
  bootstrapHarnessContextEngine,
} from "../../agents/harness/context-engine-lifecycle.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { prepareAgentPromptProjects } from "../../agents/prompt-projects.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { sessionManagerReadTranscriptBranch } from "../../agents/sessions/session-manager-view-types.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { TranscriptPolicy } from "../../agents/transcript-policy.types.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createDiagnosticTraceContextFromActiveScope } from "../../infra/diagnostic-trace-context.js";
import type { Model } from "../../llm/types.js";
import { logWarn } from "../../logger.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

export const WORKER_CONTEXT_ENGINE_HOST = {
  id: "openclaw-worker",
  label: "OpenClaw worker",
  capabilities: [
    "bootstrap",
    "assemble-before-prompt",
    "after-turn",
    "maintain",
    "runtime-llm-complete",
  ],
} satisfies ContextEngineHostSupport;

export async function prepareWorkerTurnPrompt(params: {
  turn: SessionPlacementTurnParams & {
    admittedRunContext: NonNullable<SessionPlacementTurnParams["admittedRunContext"]>;
    thinkLevel: NonNullable<SessionPlacementTurnParams["thinkLevel"]>;
  };
  agentId: string;
  workspaceDir: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  model: Model;
  surface: WorkerToolSurface;
  toolRuntime: WorkerGatewayToolRuntime;
  identity: WorkerConnectionIdentity;
  manager: SessionManager;
  transcriptPolicy: TranscriptPolicy;
  history: AgentMessage[];
  contextEngine: ContextEngine;
  contextEnginePluginId?: string;
  assertCurrent: () => void;
}) {
  const { turn, agentId, model, transcriptPolicy } = params;
  const bootstrapWorkspaceDir =
    turn.bootstrapWorkspaceDir ?? resolveAgentWorkspaceDir(turn.config ?? {}, agentId);
  const preparedModelRuntime = Object.freeze({
    ...params.preparedModelRuntime,
    ...(await prepareAgentPromptProjects(turn)),
  });
  const additions = await prepareAttemptSystemPromptAdditions({
    ...turn,
    agentId,
    provider: model.provider,
    modelId: model.id,
  });
  const attempt = {
    ...turn,
    ...additions,
    bootstrapWorkspaceDir,
    isCanonicalWorkspace: bootstrapWorkspaceDir === turn.workspaceDir,
    provider: model.provider,
    modelId: model.id,
    model,
    preparedModelRuntime,
  };
  const isRawModelRun = turn.modelRun === true || turn.promptMode === "none";
  const capabilityToolNames = new Set(
    params.surface.tools.map(({ definition }) => definition.name),
  );
  const setup = {
    sessionAgentId: agentId,
    resolvedWorkspace: turn.workspaceDir,
    effectiveWorkspace: params.workspaceDir,
    effectiveCwd: params.workspaceDir,
    sandboxSessionKey: turn.sandboxSessionKey ?? turn.sessionKey ?? turn.sessionId,
    sandbox: null,
    sandboxReport: undefined,
    proactiveSubagentOrchestration: turn.thinkLevel === "ultra",
    getProviderRuntimeHandle: () =>
      resolveProviderRuntimePluginHandle({
        provider: model.provider,
        modelId: model.id,
        config: turn.config,
        workspaceDir: turn.workspaceDir,
        pluginMetadataSnapshot: preparedModelRuntime.metadataSnapshot,
      }),
  };
  const bootstrap = await prepareEmbeddedAttemptBootstrap({
    attempt,
    setup,
    hasReadTool: capabilityToolNames.has("read"),
    isRawModelRun,
  });
  let projection = await params.toolRuntime.getPromptProjection(params.identity);
  const prompt = await prepareEmbeddedAttemptSystemPrompt({
    attempt,
    setup,
    bootstrap,
    remoteWorkspace: true,
    workerPlacement: true,
    referencePaths: { docsPath: null, sourcePath: null },
    activeContextEngine: params.contextEngine,
    capabilityToolNames,
    effectiveTools: projection.tools,
    toolSchemaDirectoryPrompt: () => projection.toolSchemaDirectoryPrompt,
    runGrantedToolDirectory: () => projection.runGrantedToolDirectory,
    isRawModelRun,
    modelToolsEnabled: capabilityToolNames.size > 0,
    skillsPrompt: turn.skillsSnapshot?.prompt ?? "",
    codeModeActive: params.surface.presentation.codeMode.enabled,
    toolSearchDirectoryEnabled: false,
    toolSearchRuntimeConfig: turn.config,
  });
  let systemPromptText = prompt.systemPromptText;
  const contextEngineTurn = {
    ...turn,
    contextEngine: params.contextEngine,
    contextEngineHostSupport: WORKER_CONTEXT_ENGINE_HOST,
    providerId: model.provider,
    modelId: model.id,
    modelContextWindow: model.contextWindow,
    tokenBudget: turn.contextTokenBudget,
    sessionManager: params.manager,
    transcriptReadFence: turn.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    runtimeContext: buildAfterTurnRuntimeContext({
      attempt,
      workspaceDir: turn.workspaceDir,
      cwd: turn.cwd ?? turn.workspaceDir,
      agentDir: preparedModelRuntime.agentDir,
      activeAgentId: agentId,
      contextEnginePluginId: params.contextEnginePluginId,
      tokenBudget: turn.contextTokenBudget,
    }),
    warn: logWarn,
  };
  params.assertCurrent();
  if (!isRawModelRun) {
    const transcriptState = await resolveExistingAttemptTranscriptState({
      ...turn,
      agentId,
      sessionManager: params.manager,
    });
    await bootstrapHarnessContextEngine({
      ...contextEngineTurn,
      hadSessionFile: transcriptState.hasBootstrapTranscriptState,
    });
    const settings = createPreparedEmbeddedAgentSettingsManager({
      sessionId: turn.sessionId,
      cwd: turn.cwd ?? turn.workspaceDir,
      agentDir: preparedModelRuntime.agentDir,
      cfg: turn.config,
      pluginMetadataSnapshot: preparedModelRuntime.metadataSnapshot,
      contextTokenBudget: turn.contextTokenBudget,
    });
    const assembled = await prepareHarnessContextEnginePrompt({
      ...contextEngineTurn,
      ...transcriptPolicy,
      agentId,
      messages: params.history,
      availableTools: capabilityToolNames,
      citationsMode: turn.config?.memory?.citations,
      sandboxed: false,
      memoryProjectKey: preparedModelRuntime.projectKey ?? undefined,
      isOpenAIResponsesApi: [
        "openai-responses",
        "azure-openai-responses",
        "openai-chatgpt-responses",
      ].includes(model.api),
      promptBudget: {
        contextTokens: turn.contextTokenBudget ?? model.contextWindow ?? model.maxTokens,
        reserveTokens: settings.getCompactionReserveTokens(),
        systemPrompt: systemPromptText,
        prompt: turn.prompt,
      },
    });
    params.history = assembled.messages;
    systemPromptText = assembled.systemPrompt;
  }
  const assembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession: { messages: params.history },
    sessionManager: params.manager,
    hookRunner: getGlobalHookRunner(),
    hookAgentId: agentId,
    diagnosticTrace: createDiagnosticTraceContextFromActiveScope(),
    isRawModelRun,
    sessionAgentId: agentId,
    runtimeModel: `${model.provider}/${model.id}`,
    systemPromptText,
    runAbortSignal: turn.abortSignal,
    hasBaselineTools: () => projection.tools.length > 0,
    applyPromptBuildToolsAllow: (toolsAllow) => {
      const names = params.toolRuntime.applyPromptToolsAllow(toolsAllow);
      capabilityToolNames.clear();
      for (const name of names) {
        capabilityToolNames.add(name);
      }
      return names;
    },
    prepareSystemPrompt: async (current) => {
      projection = await params.toolRuntime.getPromptProjection(params.identity);
      const refresh = await prompt.prepareToolPrompt?.(projection.tools);
      return refresh?.(current) ?? current;
    },
    setActiveSessionSystemPrompt: (value) => {
      systemPromptText = value;
    },
  });
  // Worker turns keep the session's pinned system prompt, like embedded turns. A change rides
  // this turn's user message as model-only text, stored on that same user row.
  let commitSystemPrompt:
    | ((manager: SessionManager, write: <T>(run: () => Promise<T>) => Promise<T>) => Promise<void>)
    | undefined;
  if (!isRawModelRun) {
    const routeKey = buildSystemPromptRouteKey({
      provider: model.provider,
      model: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      inHistorySystemUpdates: transcriptPolicy.inHistorySystemUpdates === true,
      personalProfile: turn.sessionUserProfileId,
      harness: "openclaw",
      surface: params.surface.presentation.codeMode.enabled ? "code-mode" : "direct",
    });
    // The model-context view keeps only checkpoint navigation; read the newest checkpoint whole.
    const entries = [...params.manager[sessionManagerReadTranscriptBranch]()];
    const index = entries.findLastIndex(
      (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
    );
    const checkpoint = entries[index];
    const version = params.manager.getTranscriptSnapshotVersion();
    if (checkpoint?.type === "custom" && version) {
      const reader = prepareSessionTranscriptHydration(
        resolveWorkerTurnTranscriptTarget(turn),
        undefined,
        turn.abortSignal,
      );
      const { event } = await reader.readCurrentTurnEntry({
        entryId: checkpoint.id,
        version,
        includeEntry: true,
      });
      reader.assertCurrent();
      if (isIndexedSessionEntry(event) && event.type === "custom") {
        entries[index] = { ...checkpoint, data: event.data };
      }
    }
    using lease = retainEmbeddedSessionPromptState(turn.sessionId);
    const { state } = lease;
    beginSessionSystemPrompt(state);
    const pinned = prepareSessionSystemPrompt({
      state,
      routeKey,
      systemPrompt: systemPromptText,
      entries,
      historyBoundaryCount: params.manager.getBoundaryCount(),
    });
    params.history = retireUserRowPromptUpdates(params.history, entries, pinned.restart);
    if (pinned.update) {
      assembly.effectivePrompt = `${assembly.effectivePrompt}\n\n${pinned.update.content}`;
    }
    systemPromptText = pinned.systemPrompt;
    // The checkpoint follows the worker's committed rows; a failed turn writes none. Its
    // restart flag marks a rebuild, so no separate retirement row is written first.
    commitSystemPrompt = async (manager, write) => {
      pinned.commit();
      await persistSessionSystemPrompt(state, (customType, data) =>
        write(() =>
          withSessionManagerWrite(manager, () => manager.appendCustomEntryAsync(customType, data)),
        ),
      );
    };
  }
  const context = await prepareEmbeddedAttemptPromptContext({
    ...transcriptPolicy,
    attempt,
    messages: params.history,
    prompt: assembly,
    capabilityToolNames,
    executionHost: false,
    sessionVersion: params.manager.getHeader()?.version,
    boundaryTimezone: resolveUserTimezone(turn.config?.agents?.defaults?.userTimezone),
    includeBoundaryTimestamp: !isRawModelRun,
    isRawModelRun,
    preparedUserTurnMessage: turn.userTurnTranscriptRecorder?.message,
    replaceSessionMessages: (messages) => {
      params.history = messages;
    },
    sessionAgentId: agentId,
    systemPromptText,
    systemPromptReport: prompt.systemPromptReport,
    systemPromptRuntimeContextFragments: prompt.runtimeContextFragments,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
  });
  const history = context.hookMessagesForCurrentPrompt;
  if (context.runtimeContextMessageForCurrentTurn) {
    history.pop();
  }
  params.assertCurrent();
  return {
    contextEngineTurn,
    systemPromptText,
    systemPromptReport: prompt.systemPromptReport,
    commitSystemPrompt,
    // The worker's user row keeps the model-only text, so replay sends the same bytes.
    modelPromptProjection:
      context.promptForModel === context.promptForSession ? undefined : context.promptForModel,
    history,
    prompt: context.llmBoundaryPromptForPrecheck,
    runtimeContext: isRawModelRun ? undefined : context.runtimeContextFragments,
    inHistorySystemUpdates: transcriptPolicy.inHistorySystemUpdates,
    includeEmptySnapshots: transcriptPolicy.appendOnlyRuntimeContext === true,
  };
}

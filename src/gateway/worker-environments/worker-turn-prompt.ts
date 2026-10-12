import type { WorkerToolSurface } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agents/agent-project-settings.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { prepareEmbeddedAttemptBootstrap } from "../../agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
  type EmbeddedAttemptSteeringLease,
} from "../../agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import { prepareAttemptSystemPromptAdditions } from "../../agents/embedded-agent-runner/run/attempt-system-prompt-additions.js";
import { prepareEmbeddedAttemptSystemPrompt } from "../../agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js";
import { resolveExistingAttemptTranscriptState } from "../../agents/embedded-agent-runner/run/attempt-transcript-helpers.js";
import { createToolResultPromptProjectionState } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import {
  prepareHarnessContextEnginePrompt,
  bootstrapHarnessContextEngine,
} from "../../agents/harness/context-engine-lifecycle.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { prepareAgentPromptProjects } from "../../agents/prompt-projects.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { TranscriptPolicy } from "../../agents/transcript-policy.types.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createDiagnosticTraceContextFromActiveScope } from "../../infra/diagnostic-trace-context.js";
import type { Model } from "../../llm/types.js";
import { logWarn } from "../../logger.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";

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
  setLeasedSteering: (lease: EmbeddedAttemptSteeringLease) => void;
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
    referencePaths: { docsPath: null, sourcePath: null },
    activeContextEngine: params.contextEngine,
    capabilityToolNames,
    effectiveTools: projection.tools,
    toolSchemaDirectoryPrompt: () => projection.toolSchemaDirectoryPrompt,
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
    setLeasedSteering: params.setLeasedSteering,
  });
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
    history,
    prompt: context.llmBoundaryPromptForPrecheck,
    runtimeContext: isRawModelRun ? undefined : context.runtimeContextFragments,
    inHistorySystemUpdates: transcriptPolicy.inHistorySystemUpdates,
    includeEmptySnapshots: transcriptPolicy.appendOnlyRuntimeContext === true,
  };
}

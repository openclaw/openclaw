import type { SkillResourceDelivery } from "../../packages/gateway-protocol/src/schema/skill-resources.js";
import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type {
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { copyAgentToolMetadata } from "../agents/agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import { projectMemoryFlushTools } from "../agents/agent-tools.memory-flush.js";
import { disposeAllCodeModeRuns } from "../agents/code-mode-state.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/defaults.js";
import { buildBootstrapContextForFiles } from "../agents/embedded-agent-helpers/bootstrap.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { DefaultResourceLoader } from "../agents/sessions/resource-loader.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { wrapToolWithGatewayCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type { AssistantMessage } from "../llm/types.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { materializeSkillResources } from "../skills/runtime/resources.js";
import { createWorkerBrowserToolRuntime, type WorkerBrowserRuntime } from "./browser-runtime.js";
import { createWorkerComputerTool } from "./computer-runtime.js";
import { createWorkerLiveRuntime, type WorkerLiveClient } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toWorkerInferenceContext,
  type WorkerTranscriptClient,
} from "./embedded-agent-transcript.runtime.js";
import type { createWorkerInferenceStreamAdapter } from "./inference-stream.runtime.js";
import type { WorkerBrowserLaunchDescriptor, WorkerLaunchPlan } from "./launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { createWorkerGatewayToolProxies } from "./worker-gateway-tools.js";
import { createWorkerPlacementTools, WORKER_TOOL_CONFIG } from "./worker-placement-tools.js";

function toWorkerAgentError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

type RunWorkerEmbeddedTurnParams = {
  skillResources?: SkillResourceDelivery;
  agentId: string;
  operationalRunInstance: OperationalRunInstanceRef;
  agentRuntimeIdentityToken: string;
  cwd: string;
  workerContainmentRoot: string;
  stateDir: string;
  github?: PreparedGitHubToolEnvironment;
  sessionId: string;
  sessionKey: string;
  runId: string;
  prompt: WorkerLaunchPlan["assignment"]["prompt"];
  modelRef: WorkerInferenceModelRef;
  inference: { stream: ReturnType<typeof createWorkerInferenceStreamAdapter> };
  transcript: WorkerTranscriptClient;
  live: WorkerLiveClient;
  gatewayTools: Parameters<typeof createWorkerGatewayToolProxies>[1];
  toolSurface: WorkerToolSurface;
  bootstrapFiles: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>;
  initialMessages?: WorkerTranscriptMessage[];
  suppressPromptTranscript?: boolean;
  systemPrompt?: string;
  inferenceOptions?: WorkerInferenceOptions;
  allowedToolNames: readonly string[];
  permissionMode?: import("../../packages/gateway-protocol/src/schema/sessions-row.js").SessionPermissionMode;
  execAuthority: WorkerLaunchPlan["assignment"]["toolAuthority"]["exec"];
  browser?: WorkerBrowserLaunchDescriptor;
  browserRuntime?: WorkerBrowserRuntime;
  computer?: Omit<Parameters<typeof createWorkerComputerTool>[0], "runId" | "registerRunCleanup">;
  signal?: AbortSignal;
};

export async function runWorkerEmbeddedTurn(params: RunWorkerEmbeddedTurnParams): Promise<void> {
  const resources = params.skillResources
    ? await materializeSkillResources(
        params.skillResources,
        () => params.signal?.throwIfAborted(),
        { sessionId: params.sessionId, workspaceDir: params.cwd },
      )
    : undefined;
  try {
    const browserAuthorized = params.allowedToolNames.includes("browser");
    if (browserAuthorized !== (params.browser !== undefined)) {
      throw new Error("Worker Browser authority and launch descriptor must be provided together.");
    }
    if (params.allowedToolNames.includes("computer") !== (params.computer !== undefined)) {
      throw new Error("Worker computer authority and launch descriptor must be provided together.");
    }
    if (params.operationalRunInstance.runId !== params.runId) {
      throw new Error("worker operational run instance disagrees with the admitted turn");
    }
    const toolSurface = params.toolSurface;
    const model = createNativeModelOwnedRuntimeModel({
      provider: params.modelRef.provider,
      modelId: params.modelRef.model,
    });
    model.contextWindow = toolSurface.policy.modelContextWindowTokens ?? model.contextWindow;
    if (toolSurface.policy.modelHasVision !== undefined) {
      model.input = toolSurface.policy.modelHasVision ? ["text", "image"] : ["text"];
    }
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const contextFiles = buildBootstrapContextForFiles(params.bootstrapFiles, {});
    let toolSchemaDirectoryPrompt: string | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: params.cwd,
      agentDir: params.stateDir,
      settingsManager,
      // The Gateway supplies literal text, not a local prompt-file path.
      appendSystemPromptTransform: () =>
        [params.systemPrompt, resources?.snapshot.prompt, toolSchemaDirectoryPrompt].filter(
          (prompt): prompt is string => Boolean(prompt),
        ),
      agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
    });
    const baseSessionManager = SessionManager.inMemory(params.cwd);
    for (const message of params.initialMessages ?? []) {
      await baseSessionManager.appendMessageAsync(structuredClone(message));
    }

    const transcriptRuntime = createWorkerTranscriptRuntime(params.transcript, params.signal);
    const sessionManager = guardSessionManager(baseSessionManager, {
      suppressNextUserMessagePersistence: params.suppressPromptTranscript,
      onMessagePersisted: transcriptRuntime.onMessagePersisted,
    });

    const allowedToolNameSet = new Set<string>(params.allowedToolNames);
    for (const entry of toolSurface.tools) {
      if (entry.execution === "placement" && !allowedToolNameSet.has(entry.definition.name)) {
        throw new Error(`Worker tool surface exceeds launch authority: ${entry.definition.name}`);
      }
    }
    const activeToolNames = new Set(toolSurface.tools.map(({ definition }) => definition.name));
    const coreTools = projectMemoryFlushTools(
      createWorkerPlacementTools({
        ...params,
        policy: toolSurface.policy,
        containmentRoot: params.workerContainmentRoot,
        skillsSnapshot: resources?.snapshot,
      }),
      toolSurface.policy.memoryFlushWritePath
        ? {
            root: params.workerContainmentRoot,
            relativePath: toolSurface.policy.memoryFlushWritePath,
          }
        : undefined,
    );
    const browserRuntime =
      params.browser && activeToolNames.has("browser")
        ? await createWorkerBrowserToolRuntime({
            descriptor: params.browser,
            sessionKey: params.sessionKey,
            stateDir: params.stateDir,
            workspaceDir: params.cwd,
            ...(params.browserRuntime ? { runtime: params.browserRuntime } : {}),
          })
        : undefined;
    const turnLifetime = new AbortController();
    const toolSignal = params.signal
      ? AbortSignal.any([params.signal, turnLifetime.signal])
      : turnLifetime.signal;
    let computerCleanup: ((reason: string) => Promise<void>) | undefined;
    let toolSurfaceRuntime: ReturnType<typeof createAgentHarnessToolSurfaceRuntimeCore> | undefined;
    function disposeTools(failure: Error): Promise<Error>;
    function disposeTools(failure?: Error): Promise<Error | undefined>;
    async function disposeTools(failure?: Error): Promise<Error | undefined> {
      turnLifetime.abort();
      const cleanup = computerCleanup;
      computerCleanup = undefined;
      const failures = failure ? [failure] : [];
      const disposals = await Promise.allSettled(
        [
          () => toolSurfaceRuntime?.cleanup(),
          () => cleanup?.("Worker turn finished"),
          () => browserRuntime?.dispose(),
          disposeAllCodeModeRuns,
        ].map(async (dispose) => await dispose()),
      );
      for (const disposal of disposals) {
        if (disposal.status === "rejected") {
          const cleanupFailure = toWorkerAgentError(disposal.reason, "Worker tool cleanup failed.");
          recordModelFallbackStop(cleanupFailure);
          failures.push(cleanupFailure);
        }
      }
      return failures.length > 1 ? new AggregateError(failures, "Worker turn failed") : failures[0];
    }
    const { session } = await (async () => {
      try {
        const computerTool =
          params.computer && activeToolNames.has("computer")
            ? createWorkerComputerTool({
                ...params.computer,
                runId: params.runId,
                registerRunCleanup: (cleanup) => {
                  computerCleanup = cleanup;
                },
              })
            : undefined;
        const localTools = new Map(
          [
            ...coreTools,
            ...(browserRuntime ? [browserRuntime.tool] : []),
            ...(computerTool ? [computerTool] : []),
          ].map((tool) => [tool.name, tool]),
        );
        const gatewayTools = new Map(
          createWorkerGatewayToolProxies(toolSurface, params.gatewayTools).map((tool) => [
            tool.name,
            tool,
          ]),
        );
        const tools = toolSurface.tools.map((entry) => {
          if (entry.execution === "gateway") {
            return wrapToolWithAbortSignal(gatewayTools.get(entry.definition.name)!, toolSignal);
          }
          const source = localTools.get(entry.definition.name);
          if (!source) {
            throw new Error(`Worker placement tool unavailable: ${entry.definition.name}`);
          }
          const tool = copyAgentToolMetadata(source, { ...source, ...entry.definition });
          if (entry.plugin) {
            setPluginToolMeta(tool, entry.plugin);
          }
          return wrapToolWithGatewayCallerIdentity(
            wrapToolWithAbortSignal(
              wrapToolWithBeforeToolCallHook(tool, {
                agentId: params.agentId,
                config: WORKER_TOOL_CONFIG,
                cwd: params.cwd,
                workspaceDir: params.cwd,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                runId: params.runId,
                requester: { senderIsOwner: true },
              }),
              toolSignal,
            ),
            {
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              operationalRunInstance: params.operationalRunInstance,
              signedAgentRuntimeIdentityToken: params.agentRuntimeIdentityToken,
            },
          );
        });

        toolSurfaceRuntime = createAgentHarnessToolSurfaceRuntimeCore({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          abortSignal: toolSignal,
          presentation: toolSurface.presentation,
          supportsDeferredToolCalls: false,
          modelToolsEnabled: tools.length > 0,
          model,
        });
        const projected = toolSurfaceRuntime
          .compactTools(tools, {
            prepared: { abortSignal: toolSignal, preserveToolNames: [] },
          })
          .promptToolPolicy.apply();
        toolSchemaDirectoryPrompt = projected.toolSchemaDirectoryPrompt;
        await resourceLoader.reload();
        return await createAgentSession({
          cwd: params.cwd,
          agentDir: params.stateDir,
          authStorage,
          modelRegistry,
          model,
          thinkingLevel: "medium",
          tools: projected.tools.map((tool) => tool.name),
          customTools: toToolDefinitions(projected.tools),
          sessionManager,
          settingsManager,
          resourceLoader,
          withSessionWriteSettlement: transcriptRuntime.withSessionWriteSettlement,
        });
      } catch (error) {
        throw await disposeTools(toWorkerAgentError(error, "Worker agent setup failed."));
      }
    })();
    session.agent.sessionId = params.sessionId;
    session.agent.streamFn = (_model, context, options) => {
      const projected = toWorkerInferenceContext(context);
      if (projected.kind === "provider-replay-unavailable") {
        throw new Error(
          `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (${projected.details.reason})`,
        );
      }
      return params.inference.stream({
        modelRef: params.modelRef,
        context: projected.context,
        options: structuredClone(params.inferenceOptions ?? {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    };

    const liveRuntime = createWorkerLiveRuntime(params.live);
    const unsubscribe = session.subscribe(liveRuntime.handleSessionEvent);

    const abortTurn = () => session.agent.abort();
    params.signal?.addEventListener("abort", abortTurn, { once: true });

    let runFailure: Error | undefined;
    try {
      if (params.signal?.aborted) {
        throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
      }
      const content =
        typeof params.prompt === "string"
          ? [{ type: "text" as const, text: params.prompt }]
          : [...params.prompt];
      if (resources) {
        for (const [index, part] of content.entries()) {
          if (part.type === "text") {
            content[index] = { ...part, text: resources.rewriteReferences(part.text) };
          }
        }
      }
      await session.agent.prompt({
        role: "user",
        content,
        timestamp: Date.now(),
      });
      await session.agent.waitForIdle();
      if (params.signal?.aborted) {
        throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
      }
      const terminalAssistant = session.agent.state.messages
        .toReversed()
        .find((message): message is AssistantMessage => message.role === "assistant");
      if (terminalAssistant?.stopReason === "error") {
        throw new Error(terminalAssistant.errorMessage ?? "Worker inference failed.");
      }
      if (terminalAssistant?.stopReason === "aborted") {
        throw new Error(terminalAssistant.errorMessage ?? "Worker inference was aborted.");
      }
    } catch (error) {
      runFailure = params.signal?.aborted
        ? toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.")
        : toWorkerAgentError(error, "Worker agent turn failed.");
    }

    try {
      // Cleanup and transcript writes have separate owners after the agent is idle.
      // Both must settle before the terminal ACK fences further desktop RPCs.
      const [cleanupFailure, transcriptFailure] = await Promise.all([
        disposeTools(runFailure),
        transcriptRuntime
          .withSessionWriteSettlement(() => undefined)
          .catch((error: unknown) => toWorkerAgentError(error, "Worker transcript flush failed.")),
      ]);
      runFailure = cleanupFailure;
      if (runFailure) {
        liveRuntime.enqueueRunFailure({
          aborted: params.signal?.aborted === true,
          error: runFailure,
        });
      }
      if (transcriptFailure) {
        throw runFailure ?? transcriptFailure;
      }
      await liveRuntime.emitTerminal();
    } finally {
      // Tools and prepared calls belong to this turn; promoted processes belong
      // to the enclosing environment and remain reachable through fresh tools.
      turnLifetime.abort();
      params.signal?.removeEventListener("abort", abortTurn);
      unsubscribe();
      session.dispose();
    }
    if (runFailure !== undefined) {
      throw runFailure;
    }
  } finally {
    await resources?.cleanup();
  }
}

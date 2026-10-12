import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels } from "@openclaw/ai/internal/runtime";
import { projectSessionEntryMessage } from "../../packages/agent-core/src/harness/session/session.js";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { copyAgentToolMetadata } from "../agents/agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import { projectMemoryFlushTools } from "../agents/agent-tools.memory-flush.js";
import { disposeAllCodeModeRuns } from "../agents/code-mode-state.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/defaults.js";
import { buildRuntimeContextCustomMessage } from "../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { projectRuntimeContextFragments } from "../agents/internal-runtime-context.js";
import { buildExecutionHostRuntimeFacts } from "../agents/runtime-execution-facts.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { DefaultResourceLoader } from "../agents/sessions/resource-loader.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { detectRuntimeShell, getShellConfig } from "../agents/shell-utils.js";
import { resolveSystemPromptRepoRoot } from "../agents/system-prompt-params.js";
import { completeSystemPromptRuntime } from "../agents/system-prompt-runtime.js";
import { wrapToolWithGatewayCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../infra/os-summary.js";
import type { AssistantMessage } from "../llm/types.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";
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
import type { WorkerLaunchPlan } from "./launch-descriptor.js";
import { createNativeInferenceStreamGuard } from "./native-inference-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import { createWorkerGatewayToolProxies } from "./worker-gateway-tools.js";
import { createWorkerPlacementTools, WORKER_TOOL_CONFIG } from "./worker-placement-tools.js";

function toWorkerAgentError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

type RunWorkerEmbeddedTurnParams = Omit<
  WorkerLaunchPlan["assignment"],
  | "workspaceDir"
  | "github"
  | "transcript"
  | "liveEvents"
  | "computer"
  | "toolAuthority"
  | "inference"
> & {
  cwd: string;
  workerContainmentRoot: string;
  stateDir: string;
  github?: PreparedGitHubToolEnvironment;
  sessionId: string;
  sessionKey: string;
  inference: { stream: ReturnType<typeof createWorkerInferenceStreamAdapter> };
  nativeInference?: NativeRuntimeResolved;
  transcript: WorkerTranscriptClient;
  live: WorkerLiveClient;
  gatewayTools: Parameters<typeof createWorkerGatewayToolProxies>[1];
  toolSurface: WorkerToolSurface;
  allowedToolNames: readonly string[];
  execAuthority: WorkerLaunchPlan["assignment"]["toolAuthority"]["exec"];
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
    const model =
      params.nativeInference?.model ??
      createNativeModelOwnedRuntimeModel({
        provider: params.modelRef.provider,
        modelId: params.modelRef.model,
      });
    if (!params.nativeInference) {
      model.contextWindow = toolSurface.policy.modelContextWindowTokens ?? model.contextWindow;
      if (toolSurface.policy.modelHasVision !== undefined) {
        model.input = toolSurface.policy.modelHasVision ? ["text", "image"] : ["text"];
      }
    }
    const requestedReasoning = params.inferenceOptions?.reasoning;
    if (params.nativeInference && requestedReasoning === "adaptive") {
      throw new Error("Adaptive thinking is not supported by runtime-local worker inference");
    }
    const thinkingLevel = params.nativeInference
      ? requestedReasoning === "adaptive"
        ? "off"
        : (requestedReasoning ?? "off")
      : "medium";
    if (params.nativeInference && !getSupportedThinkingLevels(model).includes(thinkingLevel)) {
      throw new Error("Requested thinking level is not supported by the node-local model");
    }
    if (
      params.nativeInference &&
      ((params.inferenceOptions?.maxTokens !== undefined &&
        params.inferenceOptions.maxTokens !== model.maxTokens) ||
        Object.values(params.inferenceOptions?.thinkingBudgets ?? {}).some(
          (budget) => budget !== undefined && budget > model.maxTokens,
        ))
    ) {
      throw new Error("Worker inference options exceed or override the node-local model budget");
    }
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: params.cwd,
      agentDir: params.stateDir,
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
    const appendCustomMessage = sessionManager.appendCustomMessageEntryAsync.bind(sessionManager);
    // Custom entries bypass the message guard but share its remote commit queue.
    sessionManager.appendCustomMessageEntryAsync = async (
      customType,
      content,
      display,
      details,
    ) => {
      const entryId = await appendCustomMessage(customType, content, display, details);
      const entry = sessionManager.getEntry(entryId);
      const message = entry && projectSessionEntryMessage(entry);
      if (!message) {
        throw new Error("Worker custom message was not committed");
      }
      transcriptRuntime.onMessagePersisted(message);
      return entryId;
    };

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
            sessionKey: toAgentStoreSessionKey({
              agentId: params.agentId,
              requestKey: params.sessionKey,
            }),
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
        await resourceLoader.reload();
        const systemPrompt = completeSystemPromptRuntime(params.systemPrompt ?? "", {
          host: await getMachineDisplayName(),
          os: resolveRuntimeOsLabel(),
          arch: os.arch(),
          node: process.version,
          shell: detectRuntimeShell() ?? path.basename(getShellConfig().shell),
          repoRoot: resolveSystemPromptRepoRoot({ workspaceDir: params.cwd, cwd: params.cwd }),
        });
        return await createAgentSession({
          systemPrompt: resources?.rewriteReferences(systemPrompt) ?? systemPrompt,
          cwd: params.cwd,
          modelRegistry,
          model,
          thinkingLevel,
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
    const guardNativeStream = params.nativeInference
      ? createNativeInferenceStreamGuard(params.nativeInference)
      : undefined;
    session.agent.streamFn = async (_model, context, options) => {
      if (params.nativeInference && guardNativeStream) {
        const native = params.nativeInference;
        return guardNativeStream(
          () =>
            native.streamFn(model, context, {
              ...params.inferenceOptions,
              reasoning: thinkingLevel,
              signal: options?.signal,
            }),
          options?.signal,
        );
      }
      const projected = toWorkerInferenceContext(context);
      if (projected.kind === "provider-replay-unavailable") {
        throw new Error(
          `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (${projected.details.reason})`,
        );
      }
      return params.inference.stream({
        modelRef: params.modelRef,
        context: projected.context,
        options: structuredClone(params.inferenceOptions),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    };

    const liveRuntime = createWorkerLiveRuntime(params.live);
    const unsubscribe = session.subscribe(liveRuntime.handleSessionEvent);

    const abortTurn = () => session.agent.abort();
    params.signal?.addEventListener("abort", abortTurn, { once: true });

    let runFailure: Error | undefined;
    try {
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
      const fragments = params.runtimeContext
        ? [
            ...(await buildExecutionHostRuntimeFacts({
              ...params,
              capabilityToolNames: activeToolNames,
            })),
            ...params.runtimeContext,
          ]
        : [];
      const runtimeContext = buildRuntimeContextCustomMessage(
        projectRuntimeContextFragments(fragments),
        fragments,
        params.inHistorySystemUpdates,
      );
      if (params.signal?.aborted) {
        throw toWorkerAgentError(params.signal.reason, "Worker agent turn aborted.");
      }
      await session.agent.prompt([
        { role: "user", content, timestamp: Date.now() },
        ...(runtimeContext ? [runtimeContext] : []),
      ]);
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

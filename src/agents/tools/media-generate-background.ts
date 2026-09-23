/** Owns image, music, and video preflight, task admission, and detached completion. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasSessionDeliveryRuntime } from "../../infra/session-delivery-queue-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { recordRecentMediaGenerationTaskStartForSession } from "../media-generation-task-status-shared.js";
import {
  IMAGE_GENERATION_TASK_KIND,
  MUSIC_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "../media-generation-task-status.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { ToolInputError, readToolStringParam } from "./common.js";
import {
  buildMediaGenerationStartedToolResult,
  createMediaGenerationTaskLifecycle,
  notifyMediaGenerationAsyncTaskStarted,
  scheduleMediaGenerationTaskCompletion,
  shouldDetachMediaGenerationTask,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
  type MediaGenerationExecutionResult,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";
import type { MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
import { rethrowAfterMediaCleanup } from "./media-generation-error.js";
import {
  hasExplicitMediaModel,
  resolveCapabilityModelConfigForTool,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import { applyAgentDefaultModelConfig, type ToolModelConfig } from "./model-config.helpers.js";
import type { ToolFsPolicy } from "./tool-runtime.helpers.js";

export type MediaGenerateToolOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  cwd?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
};

/** Transferred resources belong to queued work through actual generation and persistence. */
export type MediaGenerationTaskResources = {
  run: <T>(run: () => T | Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

/** Preflight retains resources until a duplicate result releases them or task admission takes over. */
export async function prepareMediaGenerationTask<
  T extends MediaGenerationExecutionResult,
  Resources extends (MediaGenerationTaskResources & { assertOpen: () => void }) | undefined,
>(params: {
  generationLabel: "image" | "video" | "music";
  cfg: OpenClawConfig;
  args: Record<string, unknown>;
  model?: string;
  options?: MediaGenerateToolOptions;
  acquire: (cfg: OpenClawConfig) => Promise<Resources>;
  resolveProviders: (
    resources: Resources,
  ) => Parameters<typeof resolveCapabilityModelConfigForTool>[0]["providers"];
  findDuplicate: (
    sessionKey: string | undefined,
    request: { prompt: string; agentId?: string },
  ) => Promise<MediaGenerateActionResult | undefined>;
  signal?: AbortSignal;
  prepare: (context: {
    resources: Resources;
    modelConfig: ToolModelConfig;
    effectiveCfg: OpenClawConfig;
    prompt: string;
    explicitModelConfig: boolean;
  }) => Promise<
    | { kind: "result"; result: MediaGenerateActionResult }
    | {
        kind: "task";
        params: Omit<
          Parameters<typeof runMediaGenerationTask<T>>[0],
          "resources" | "generationLabel"
        >;
      }
  >;
}) {
  const { cfg, generationLabel, model, options, signal } = params;
  const explicitModelConfig = hasExplicitMediaModel(
    cfg.agents?.defaults?.mediaModels?.[generationLabel],
  );
  const configuredModel =
    model || explicitModelConfig
      ? resolveCapabilityModelConfigForTool({
          cfg,
          modelConfig: cfg.agents?.defaults?.mediaModels?.[generationLabel],
          modelOverride: model,
          providers: [],
        })
      : null;
  const readRequest = async () => {
    const prompt = readToolStringParam(params.args, "prompt", { required: true });
    return {
      prompt,
      duplicate: await params.findDuplicate(options?.agentSessionKey, {
        prompt,
        agentId: options?.requesterAgentId,
      }),
    };
  };
  const configuredRequest = configuredModel ? await readRequest() : undefined;
  if (configuredRequest?.duplicate) {
    return configuredRequest.duplicate;
  }
  signal?.throwIfAborted();
  const resources = await params.acquire(
    configuredModel
      ? (applyAgentDefaultModelConfig(cfg, generationLabel, configuredModel) ?? cfg)
      : cfg,
  );
  const prepare = async () => {
    const modelConfig =
      configuredModel ??
      resolveCapabilityModelConfigForTool({
        cfg,
        workspaceDir: options?.workspaceDir,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
        modelConfig: cfg.agents?.defaults?.mediaModels?.[generationLabel],
        modelOverride: model,
        providers: params.resolveProviders(resources),
      });
    if (!modelConfig) {
      throw new ToolInputError(`No ${generationLabel}-generation model configured.`);
    }
    const effectiveCfg = applyAgentDefaultModelConfig(cfg, generationLabel, modelConfig) ?? cfg;
    const { prompt, duplicate } = configuredRequest ?? (await readRequest());
    if (duplicate) {
      return { kind: "result" as const, result: duplicate };
    }
    signal?.throwIfAborted();
    resources?.assertOpen();
    return params.prepare({ resources, modelConfig, effectiveCfg, prompt, explicitModelConfig });
  };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    resources?.assertOpen();
    prepared = resources ? await resources.run(prepare) : await prepare();
    if (prepared.kind === "task") {
      // Cancellation fences admission; accepted work retains resources independently.
      signal?.throwIfAborted();
      resources?.assertOpen();
    }
  } catch (error) {
    const title = `${params.generationLabel.charAt(0).toUpperCase()}${params.generationLabel.slice(1)}`;
    return rethrowAfterMediaCleanup(
      error,
      () => resources?.release(),
      `${title} preflight and cleanup failed`,
    );
  }
  if (prepared.kind === "result") {
    await resources?.release();
    return prepared.result;
  }
  return runMediaGenerationTask({
    ...prepared.params,
    generationLabel: params.generationLabel,
    resources,
  });
}

/** Owns task admission and the shared foreground or detached generation lifecycle. */
export async function runMediaGenerationTask<T extends MediaGenerationExecutionResult>(params: {
  lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
  generationLabel: "image" | "video" | "music";
  sessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  requestKey: string;
  providerId?: string;
  config?: OpenClawConfig;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
  resources?: MediaGenerationTaskResources;
  run: (
    handle: MediaGenerationTaskHandle | null,
  ) => Promise<T & { contentText: string; details: Record<string, unknown> }>;
}) {
  const resources = params.resources;
  let resourcesTransferred = false;
  const run = resources
    ? async (handle: MediaGenerationTaskHandle | null) => {
        resourcesTransferred = true;
        let executed: T & { contentText: string; details: Record<string, unknown> };
        try {
          executed = await resources.run(() => params.run(handle));
        } catch (error) {
          return rethrowAfterMediaCleanup(
            error,
            () => resources.release(),
            "Media generation and cleanup failed",
          );
        }
        await resources.release();
        return executed;
      }
    : params.run;
  try {
    const { generationLabel, lifecycle } = params;
    const toolName = `${generationLabel}_generate`;
    const progressSummary = `Generating ${generationLabel}`;
    const title = `${generationLabel.charAt(0).toUpperCase()}${generationLabel.slice(1)}`;
    const handle = lifecycle.createTaskRun({
      sessionKey: params.sessionKey,
      requesterAgentId: params.requesterAgentId,
      requesterOrigin: params.requesterOrigin,
      prompt: params.prompt,
      providerId: params.providerId,
    });

    // One-shot callers have no queue runtime to finish a detached task. Return
    // their generated result (or error) through the existing foreground path.
    if (
      handle &&
      hasSessionDeliveryRuntime() &&
      shouldDetachMediaGenerationTask(params.sessionKey, params.requesterAgentId)
    ) {
      recordRecentMediaGenerationTaskStartForSession({
        sessionKey: params.sessionKey,
        agentId: params.requesterAgentId,
        taskKind: `${generationLabel}_generation`,
        sourcePrefix: toolName,
        taskId: handle.taskId,
        runId: handle.runId,
        taskLabel: params.prompt,
        requestKey: params.requestKey,
        providerId: params.providerId,
        progressSummary,
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: params.scheduleBackgroundWork,
        progressSummary,
        config: params.config,
        toolName: `${title} generation`,
        onWakeFailure: params.onFailure,
        run: () => run(handle),
      });
      resourcesTransferred = true;
      await notifyMediaGenerationAsyncTaskStarted({
        callback: params.onAsyncTaskStarted,
        message: `${title} generation started; wait for the generated ${generationLabel} completion event.`,
        toolName,
        handle,
        onFailure: params.onFailure,
      });
      return buildMediaGenerationStartedToolResult({
        toolName,
        generationLabel,
        completionLabel: generationLabel,
        taskHandle: handle,
        detailExtras: params.detailExtras,
        messages: params.messages,
      });
    }

    try {
      const executed = await run(handle);
      lifecycle.completeTaskRun({
        handle,
        provider: executed.provider,
        model: executed.model,
        count: executed.count,
      });
      return {
        content: [{ type: "text" as const, text: executed.contentText }],
        details: executed.details,
      };
    } catch (error) {
      lifecycle.failTaskRun({ handle, error });
      throw error;
    }
  } catch (error) {
    // Admission or scheduling can fail before the callback owns the resource claim.
    if (resources && !resourcesTransferred) {
      return rethrowAfterMediaCleanup(
        error,
        () => resources.release(),
        "Media admission and cleanup failed",
      );
    }
    throw error;
  }
}

export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;
export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;
export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

function createGenerationTaskLifecycle(
  kind: "image" | "music" | "video",
  taskKind: Parameters<typeof createMediaGenerationTaskLifecycle>[0]["taskKind"],
) {
  const title = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return createMediaGenerationTaskLifecycle({
    toolName: `${kind}_generate`,
    taskKind,
    label: `${title} generation`,
    queuedProgressSummary: `Queued ${kind} generation`,
    generatedLabel: kind === "music" ? "track" : kind,
    failureProgressSummary: `${title} generation failed`,
    eventSource: `${kind}_generation`,
    announceType: `${kind} generation task`,
    completionLabel: kind,
  });
}

export const imageGenerationTaskLifecycle = createGenerationTaskLifecycle(
  "image",
  IMAGE_GENERATION_TASK_KIND,
);
export const musicGenerationTaskLifecycle = createGenerationTaskLifecycle(
  "music",
  MUSIC_GENERATION_TASK_KIND,
);
export const videoGenerationTaskLifecycle = createGenerationTaskLifecycle(
  "video",
  VIDEO_GENERATION_TASK_KIND,
);

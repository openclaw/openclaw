import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CapabilityProviderFor } from "../../plugins/capability-provider-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { recordRecentMediaGenerationTaskStartForSession } from "../media-generation-task-status-shared.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { ToolInputError, readToolStringParam } from "./common.js";
import {
  captureMediaGenerationAdmission,
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
  type MediaGenerationExecutionResult,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";
import type { MediaGenerateActionResult } from "./media-generate-tool-actions-shared.js";
import { rethrowAfterMediaCleanup } from "./media-generation-error.js";
import {
  hasGenerationToolAvailability,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolSandboxConfig,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  applyAgentDefaultModelConfig,
  coerceToolModelConfig,
  hasToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";

export type MediaGenerateToolOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  /** Durable requester transcript key; task ownership stays on agentSessionKey. */
  requesterRunSessionKey?: string;
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

const GENERATION_LABELS = {
  imageGenerationProviders: "image",
  musicGenerationProviders: "music",
  videoGenerationProviders: "video",
} as const;

export function resolveMediaGenerateToolContext<K extends keyof typeof GENERATION_LABELS>(
  providerKey: K,
  options?: MediaGenerateToolOptions,
) {
  const cfg = options?.config ?? getRuntimeConfig();
  const knownProviders:
    | { [P in keyof typeof GENERATION_LABELS]?: readonly CapabilityProviderFor<P>[] }
    | undefined = options?.preparedModelRuntime?.mediaCapabilityProviders;
  const known = knownProviders?.[providerKey];
  const preparedProviders = known ? [...known] : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.[GENERATION_LABELS[providerKey]],
      providerKey,
      providers: preparedProviders,
    })
  ) {
    return null;
  }
  return {
    cfg,
    preparedProviders,
    sandboxConfig: resolveMediaToolSandboxConfig(
      options?.sandbox,
      options?.fsPolicy?.workspaceOnly,
    ),
  };
}

/** Transferred resources belong to queued work through actual generation and persistence. */
type MediaGenerationTaskResources = {
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
  const assertSourceCurrent = captureAgentToolSourceExecutionGuard(signal);
  const explicitModelConfig = hasToolModelConfig(
    coerceToolModelConfig(cfg.agents?.defaults?.mediaModels?.[generationLabel]),
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
    requesterRunSessionKey: options?.requesterRunSessionKey,
    generationLabel: params.generationLabel,
    resources,
    assertAdmissionCurrent: () => {
      assertSourceCurrent();
      resources?.assertOpen();
    },
  });
}

export async function runMediaGenerationTask<T extends MediaGenerationExecutionResult>(params: {
  lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
  generationLabel: "image" | "video" | "music";
  sessionKey?: string;
  requesterRunSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  requestKey: string;
  providerId?: string;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
  resources?: MediaGenerationTaskResources;
  assertAdmissionCurrent?: () => void;
  run: (
    handle: MediaGenerationTaskHandle | null,
  ) => Promise<T & { contentText: string; details: Record<string, unknown> }>;
}) {
  const resources = params.resources;
  const assertAdmissionCurrent = captureMediaGenerationAdmission(params.assertAdmissionCurrent);
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
    const handle = await lifecycle.createTaskRun({
      sessionKey: params.sessionKey,
      requesterRunSessionKey: params.requesterRunSessionKey,
      requesterAgentId: params.requesterAgentId,
      requesterOrigin: params.requesterOrigin,
      prompt: params.prompt,
      providerId: params.providerId,
      assertCurrent: assertAdmissionCurrent,
    });
    try {
      assertAdmissionCurrent();
    } catch (error) {
      lifecycle.failTaskRun({ handle, error });
      throw error;
    }

    if (handle?.detach) {
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
        toolName: `${title} generation`,
        onWakeFailure: params.onFailure,
        run: () => run(handle),
      });
      resourcesTransferred = true;
      try {
        await params.onAsyncTaskStarted?.(
          `${title} generation started; wait for the generated ${generationLabel} completion event.`,
        );
      } catch (error) {
        params.onFailure("Media generation async-start callback failed", {
          toolName,
          taskId: handle.taskId,
          runId: handle.runId,
          error,
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Background task started for ${generationLabel} generation (${handle.taskId}). Do not call ${toolName} again for this request. Do not wait, poll, or yield for it: end this turn (a short acknowledgement at most); the completion arrives as a later turn and sends the finished ${generationLabel} here.`,
              ...(params.messages ?? []),
            ]
              .filter((entry): entry is string => Boolean(entry))
              .join("\n"),
          },
        ],
        details: {
          async: true,
          status: "started",
          taskId: handle.taskId,
          runId: handle.runId,
          task: { taskId: handle.taskId, runId: handle.runId },
          ...params.detailExtras,
        },
      };
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

export const imageGenerationTaskLifecycle = createMediaGenerationTaskLifecycle("image");
export const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle("music");
export const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle("video");

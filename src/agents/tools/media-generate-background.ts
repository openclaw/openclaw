import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { CapabilityProviderFor } from "../../plugins/capability-provider-runtime.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "../agent-tool-source-execution-guard.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import { updateMediaGenerationOperation } from "../media-generation-activity.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { resolveSandboxConfigForAgent } from "../sandbox/config.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { captureAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { ToolInputError, readToolStringParam } from "./common.js";
import {
  captureMediaGenerationAdmission,
  createDefaultMediaGenerateBackgroundScheduler,
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
  type MediaGenerateBackgroundScheduler,
  type MediaGenerationExecutionResult,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";
import type { AcquireGeneratedMediaSandbox } from "./media-generate-result-shared.js";
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
  prepareToolAuthProfileStore,
  type ToolModelConfig,
} from "./model-config.helpers.js";

export type MediaGenerateToolOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  agentSessionKey?: string;
  sandboxSessionKey?: string;
  sandboxAgentId?: string;
  /** Durable requester transcript key; task ownership stays on agentSessionKey. */
  requesterRunSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  inputProvenance?: InputProvenance;
  workspaceDir?: string;
  spawnWorkspaceDir?: string;
  skillsSnapshot?: SkillSnapshot;
  execOverrides?: ExecPolicyOverrides;
  cwd?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
};

const GENERATION_LABELS = {
  imageGenerationProviders: "image",
  musicGenerationProviders: "music",
  videoGenerationProviders: "video",
} as const;

export function resolveMediaGenerateToolContext<K extends keyof typeof GENERATION_LABELS>(
  providerKey: K,
  options: MediaGenerateToolOptions | undefined,
  logger: Pick<SubsystemLogger, "warn" | "error">,
  preparedAvailability?: boolean,
) {
  const cfg = options?.config ?? getRuntimeConfig();
  const knownProviders:
    | { [P in keyof typeof GENERATION_LABELS]?: readonly CapabilityProviderFor<P>[] }
    | undefined = options?.preparedModelRuntime?.mediaCapabilityProviders;
  const known = knownProviders?.[providerKey];
  const preparedProviders = known ? [...known] : undefined;
  if (
    !(
      preparedAvailability ??
      hasGenerationToolAvailability({
        cfg,
        agentDir: options?.agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
        authProfileStoreSource: options?.authProfileStoreSource,
        modelConfig: cfg.agents?.defaults?.mediaModels?.[GENERATION_LABELS[providerKey]],
        providerKey,
        providers: preparedProviders,
      })
    )
  ) {
    return null;
  }
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ??
    createDefaultMediaGenerateBackgroundScheduler({
      toolName: `${GENERATION_LABELS[providerKey]}_generate`,
      onCrash: (message, meta) => logger.error(message, meta),
    });
  const outputSandbox = options?.sandbox;
  const sandboxSessionKey = options?.sandboxSessionKey ?? options?.agentSessionKey;
  const readOutputPolicy = (config: OpenClawConfig) => ({
    sandbox: resolveSandboxConfigForAgent(config, options?.sandboxAgentId),
    workspaces: [options?.sandboxAgentId, options?.requesterAgentId].map((agentId) =>
      agentId ? resolveAgentWorkspaceDir(config, agentId) : undefined,
    ),
    sessionStore: config.session?.store,
    mediaMaxMb: config.agents?.defaults?.mediaMaxMb,
  });
  const admittedOutputPolicy = outputSandbox ? readOutputPolicy(cfg) : undefined;
  const acquireOutputSandbox: AcquireGeneratedMediaSandbox | undefined = outputSandbox
    ? async (assertCurrent) => {
        const assertSandboxCurrent = () => {
          assertCurrent();
          if (!isDeepStrictEqual(readOutputPolicy(getRuntimeConfig()), admittedOutputPolicy)) {
            throw new Error("The requesting sandbox configuration has changed");
          }
        };
        assertSandboxCurrent();
        if (!sandboxSessionKey) {
          throw new Error("The requesting sandbox session is unavailable");
        }
        // Detached generation outlives the originating turn's workspace projection.
        const { resolveSandboxContext } = await import("../sandbox/context.js");
        const sandbox = await resolveSandboxContext({
          config: getRuntimeConfig(),
          sessionKey: sandboxSessionKey,
          agentId: options?.sandboxAgentId,
          workspaceDir: options?.spawnWorkspaceDir ?? options?.workspaceDir,
          skillsSnapshot: options?.skillsSnapshot,
          execOverrides: options?.execOverrides,
          assertCurrent: assertSandboxCurrent,
        });
        try {
          assertSandboxCurrent();
          if (
            !sandbox?.fsBridge ||
            sandbox.workspaceDir !== outputSandbox.root ||
            sandbox.backendId !== admittedOutputPolicy?.sandbox.backend
          ) {
            throw new Error("The requesting sandbox workspace is no longer available");
          }
          return {
            root: sandbox.workspaceDir,
            bridge: sandbox.fsBridge,
            assertCurrent: assertSandboxCurrent,
            [Symbol.dispose]: () => sandbox[Symbol.dispose]?.(),
          };
        } catch (error) {
          sandbox?.[Symbol.dispose]?.();
          throw error;
        }
      }
    : undefined;
  return {
    cfg,
    acquireOutputSandbox,
    preparedProviders,
    workspaceReadiness: captureAgentWorkspaceReadiness(options?.agentSessionKey),
    taskOptions: () => ({
      sessionKey: options?.agentSessionKey,
      requesterAgentId: options?.requesterAgentId,
      requesterOrigin: options?.requesterOrigin,
      scheduleBackgroundWork,
      onFailure: (message: string, meta?: Record<string, unknown>) => logger.warn(message, meta),
    }),
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
        params: Omit<Parameters<typeof runMediaGenerationTask>[0], "resources" | "generationLabel">;
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
      ? await resolveCapabilityModelConfigForTool({
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
    const authStore = configuredModel
      ? options?.authProfileStore
      : await prepareToolAuthProfileStore(options);
    signal?.throwIfAborted();
    resources?.assertOpen();
    const modelConfig =
      configuredModel ??
      (await resolveCapabilityModelConfigForTool({
        cfg,
        workspaceDir: options?.workspaceDir,
        agentDir: options?.agentDir,
        authStore,
        modelConfig: cfg.agents?.defaults?.mediaModels?.[generationLabel],
        modelOverride: model,
        providers: params.resolveProviders(resources),
      }));
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
    inputProvenance: options?.inputProvenance,
    requesterRunSessionKey: options?.requesterRunSessionKey,
    generationLabel: params.generationLabel,
    resources,
    assertAdmissionCurrent: composeSessionSourceAssertion([assertSourceCurrent], (assertSource) => {
      assertSource();
      resources?.assertOpen();
    }),
  });
}

export async function runMediaGenerationTask(params: {
  lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
  generationLabel: "image" | "video" | "music";
  sessionKey?: string;
  requesterRunSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  inputProvenance?: InputProvenance;
  prompt: string;
  requestKey: string;
  providerId?: string;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
  resources?: MediaGenerationTaskResources;
  assertAdmissionCurrent?: () => void;
  run: (
    handle: MediaGenerationTaskHandle | null,
  ) => Promise<
    MediaGenerationExecutionResult & { contentText: string; details: Record<string, unknown> }
  >;
}) {
  const resources = params.resources;
  const assertAdmissionCurrent = captureMediaGenerationAdmission(params.assertAdmissionCurrent);
  let resourcesTransferred = false;
  const run = resources
    ? async (handle: MediaGenerationTaskHandle | null) => {
        resourcesTransferred = true;
        let executed: Awaited<ReturnType<typeof params.run>>;
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
      inputProvenance: params.inputProvenance ?? { kind: "external_user" },
      prompt: params.prompt,
      providerId: params.providerId,
      assertCurrent: assertAdmissionCurrent,
    });
    const admitExecution = async <T>(start: () => T): Promise<{ execution: T }> => {
      try {
        return await runWithAgentToolSourceExecutionScope(assertAdmissionCurrent, async () => {
          assertAdmissionCurrent();
          return { execution: start() };
        });
      } catch (error) {
        lifecycle.failTaskRun({ handle, error });
        throw error;
      }
    };

    if (handle?.detach) {
      updateMediaGenerationOperation(handle.runId, {
        requestKey: params.requestKey,
      });
      await admitExecution(() =>
        scheduleMediaGenerationTaskCompletion({
          lifecycle,
          handle,
          scheduleBackgroundWork: params.scheduleBackgroundWork,
          progressSummary,
          toolName: `${title} generation`,
          onWakeFailure: params.onFailure,
          run: () => run(handle),
        }),
      );
      resourcesTransferred = true;
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
      const { execution } = await admitExecution(() => run(handle));
      const executed = await execution;
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

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listRuntimeImageGenerationProviders } from "../../image-generation/runtime.js";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import { resolveProviderCapabilities } from "../../image-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildImageGenerationTaskStatusListDetails,
  buildImageGenerationTaskStatusListText,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findActiveImageGenerationTaskForSession,
  findDuplicateGuardImageGenerationTaskForSession,
  listActiveImageGenerationTasksForSession,
} from "../image-generation-task-status.js";
import {
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

export type ImageGenerateActionResult = MediaGenerateActionResult;

export function formatImageGenerationAuthHint(provider: {
  id: string;
  authEnvVars: readonly string[];
}): string | undefined {
  if (provider.id === "openai") {
    return "set OPENAI_API_KEY or configure OpenAI Codex OAuth for openai/gpt-image-2";
  }
  if (provider.authEnvVars.length === 0) {
    return undefined;
  }
  return `set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`;
}

export function listSupportedImageGenerationModes(provider: ImageGenerationProvider): string[] {
  const caps = resolveProviderCapabilities(provider.capabilities);
  return ["generate", ...(caps.edit.enabled ? ["edit"] : [])];
}

export function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string {
  const caps = resolveProviderCapabilities(provider.capabilities);
  const result: string[] = [];
  if (caps.edit.enabled) {
    const maxRefs = caps.edit.maxInputImages;
    result.push(
      `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}`,
    );
  }
  if ((caps.geometry?.resolutions?.length ?? 0) > 0) {
    result.push(`resolutions ${caps.geometry?.resolutions?.join("/")}`);
  }
  if ((caps.geometry?.sizes?.length ?? 0) > 0) {
    result.push(`sizes ${caps.geometry?.sizes?.join(", ")}`);
  }
  if ((caps.geometry?.aspectRatios?.length ?? 0) > 0) {
    result.push(`aspect ratios ${caps.geometry?.aspectRatios?.join(", ")}`);
  }
  if ((caps.output?.formats?.length ?? 0) > 0) {
    result.push(`formats ${caps.output?.formats?.join("/")}`);
  }
  if ((caps.output?.backgrounds?.length ?? 0) > 0) {
    result.push(`backgrounds ${caps.output?.backgrounds?.join("/")}`);
  }
  return result.join("; ");
}

export function createImageGenerateListActionResult(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ImageGenerateActionResult {
  const providers = listRuntimeImageGenerationProviders({ config: params.cfg });
  return createMediaGenerateProviderListActionResult({
    kind: "image_generation",
    providers,
    emptyText: "No image-generation providers are registered.",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    listModes: listSupportedImageGenerationModes,
    summarizeCapabilities: summarizeImageGenerationCapabilities,
    formatAuthHint: formatImageGenerationAuthHint,
  });
}

const imageGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
  inactiveText: "No active image generation task is currently running for this session.",
  findActiveTask: (sessionKey) => findActiveImageGenerationTaskForSession(sessionKey) ?? undefined,
  buildStatusText: buildImageGenerationTaskStatusText,
  buildStatusDetails: buildImageGenerationTaskStatusDetails,
});

export function createImageGenerateStatusActionResult(
  sessionKey?: string,
): ImageGenerateActionResult {
  const activeTasks = listActiveImageGenerationTasksForSession(sessionKey);
  if (activeTasks.length > 1) {
    return {
      content: [{ type: "text", text: buildImageGenerationTaskStatusListText(activeTasks) }],
      details: {
        action: "status",
        ...buildImageGenerationTaskStatusListDetails(activeTasks),
      },
    };
  }
  return imageGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

export function createImageGenerateDuplicateGuardResult(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string },
): ImageGenerateActionResult | undefined {
  const blockingTask = findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
    prompt: params?.prompt,
    requestKey: params?.requestKey,
  });
  if (!blockingTask) {
    return undefined;
  }
  return {
    content: [
      {
        type: "text",
        text: buildImageGenerationTaskStatusText(blockingTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...buildImageGenerationTaskStatusDetails(blockingTask),
    },
  };
}

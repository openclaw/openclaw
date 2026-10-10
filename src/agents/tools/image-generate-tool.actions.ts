import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildImageGenerationTaskStatusListDetails,
  buildImageGenerationTaskStatusListText,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findDuplicateGuardImageGenerationTaskForSession,
  listActiveImageGenerationTasksForSession,
} from "../media-generation-task-status.js";
import {
  createMediaGenerateDuplicateGuardResult,
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusResult,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string {
  const caps: string[] = [];
  if (provider.capabilities.edit.enabled) {
    const modelLimits = Object.values(provider.capabilities.edit.maxInputImagesByModel ?? {})
      .concat(Object.values(provider.capabilities.edit.maxInputImagesByModelPrefix ?? {}))
      .filter((value) => Number.isFinite(value));
    const declaredLimits = [
      ...(typeof provider.capabilities.edit.maxInputImages === "number"
        ? [provider.capabilities.edit.maxInputImages]
        : []),
      ...modelLimits,
    ];
    const maxRefs = declaredLimits.length > 0 ? Math.max(...declaredLimits) : undefined;
    caps.push(
      `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}${modelLimits.length > 0 ? " depending on model" : ""}`,
    );
  }
  const { geometry, output } = provider.capabilities;
  for (const [label, values, separator] of [
    ["resolutions", geometry?.resolutions, "/"],
    ["sizes", geometry?.sizes, ", "],
    ["aspect ratios", geometry?.aspectRatios, ", "],
    ["formats", output?.formats, "/"],
    ["backgrounds", output?.backgrounds, "/"],
  ] as const) {
    if (values?.length) {
      caps.push(`${label} ${values.join(separator)}`);
    }
  }
  return caps.join("; ");
}

export function createImageGenerateListActionResult(params: {
  cfg?: OpenClawConfig;
  providers: ImageGenerationProvider[];
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
}): MediaGenerateActionResult {
  return createMediaGenerateProviderListActionResult({
    ...params,
    kind: "image_generation",
    emptyText: "No image-generation providers are registered.",
    listModes: (provider) => ["generate", ...(provider.capabilities.edit.enabled ? ["edit"] : [])],
    summarizeCapabilities: summarizeImageGenerationCapabilities,
    formatAuthHint: (provider) =>
      provider.id === "openai"
        ? "set OPENAI_API_KEY or configure an OpenClaw Codex login OAuth profile (not SIWC) for openai/gpt-image-2"
        : undefined,
  });
}

export async function createImageGenerateStatusActionResult(
  sessionKey?: string,
  agentId?: string,
): Promise<MediaGenerateActionResult> {
  const activeTasks = await listActiveImageGenerationTasksForSession(sessionKey, agentId);
  if (activeTasks.length > 1) {
    return {
      content: [{ type: "text", text: buildImageGenerationTaskStatusListText(activeTasks) }],
      details: {
        action: "status",
        ...buildImageGenerationTaskStatusListDetails(activeTasks),
      },
    };
  }
  return createMediaGenerateTaskStatusResult({
    activeTask: activeTasks[0],
    inactiveText: "No active image generation task is currently running for this session.",
    buildStatusText: buildImageGenerationTaskStatusText,
    buildStatusDetails: buildImageGenerationTaskStatusDetails,
  });
}

export function createImageGenerateDuplicateGuardResult(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string; agentId?: string },
): Promise<MediaGenerateActionResult | undefined> {
  return createMediaGenerateDuplicateGuardResult({
    sessionKey,
    prompt: params?.prompt,
    requestKey: params?.requestKey,
    agentId: params?.agentId,
    findDuplicateTask: findDuplicateGuardImageGenerationTaskForSession,
    buildStatusText: buildImageGenerationTaskStatusText,
    buildStatusDetails: buildImageGenerationTaskStatusDetails,
  });
}

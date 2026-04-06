import type { OpenClawConfig } from "../../config/config.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import { listSupportedVideoGenerationModes } from "../../video-generation/capabilities.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
} from "../video-generation-task-status.js";

type VideoGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function getVideoGenerationProviderAuthEnvVars(providerId: string): string[] {
  return getProviderEnvVars(providerId);
}

function summarizeVideoGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeVideoGenerationProviders>[number],
): string {
  const supportedModes = listSupportedVideoGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const imageToVideo = provider.capabilities.imageToVideo;
  const videoToVideo = provider.capabilities.videoToVideo;
  const capabilities = [
    supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
    generate?.maxVideos ? `maxVideos=${generate.maxVideos}` : null,
    imageToVideo?.maxInputImages ? `maxInputImages=${imageToVideo.maxInputImages}` : null,
    videoToVideo?.maxInputVideos ? `maxInputVideos=${videoToVideo.maxInputVideos}` : null,
    generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
    generate?.supportedDurationSeconds?.length
      ? `supportedDurationSeconds=${generate.supportedDurationSeconds.join("/")}`
      : null,
    generate?.supportedDurationSecondsByModel &&
    Object.keys(generate.supportedDurationSecondsByModel).length > 0
      ? `supportedDurationSecondsByModel=${Object.entries(generate.supportedDurationSecondsByModel)
          .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
          .join("; ")}`
      : null,
    generate?.supportsResolution ? "resolution" : null,
    generate?.supportsAspectRatio ? "aspectRatio" : null,
    generate?.supportsSize ? "size" : null,
    generate?.supportsAudio ? "audio" : null,
    generate?.supportsWatermark ? "watermark" : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(", ");
  return capabilities;
}

export function createVideoGenerateListActionResult(
  config?: OpenClawConfig,
): VideoGenerateActionResult {
  const providers = listRuntimeVideoGenerationProviders({ config });
  if (providers.length === 0) {
    return {
      content: [{ type: "text", text: "No video-generation providers are registered." }],
      details: { providers: [] },
    };
  }
  const lines = providers.map((provider) => {
    const authHints = getVideoGenerationProviderAuthEnvVars(provider.id);
    const capabilities = summarizeVideoGenerationCapabilities(provider);
    return [
      `${provider.id}: default=${provider.defaultModel ?? "none"}`,
      provider.models?.length ? `models=${provider.models.join(", ")}` : null,
      capabilities ? `capabilities=${capabilities}` : null,
      authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" | ");
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      providers: providers.map((provider) => ({
        id: provider.id,
        defaultModel: provider.defaultModel,
        models: provider.models ?? [],
        modes: listSupportedVideoGenerationModes(provider),
        authEnvVars: getVideoGenerationProviderAuthEnvVars(provider.id),
        capabilities: provider.capabilities,
      })),
    },
  };
}

export function createVideoGenerateStatusActionResult(
  sessionKey?: string,
): VideoGenerateActionResult {
  const activeTask = findActiveVideoGenerationTaskForSession(sessionKey);
  if (!activeTask) {
    return {
      content: [
        {
          type: "text",
          text: "No active video generation task is currently running for this session.",
        },
      ],
      details: {
        action: "status",
        active: false,
      },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: buildVideoGenerationTaskStatusText(activeTask),
      },
    ],
    details: {
      action: "status",
      ...buildVideoGenerationTaskStatusDetails(activeTask),
    },
  };
}

export function createVideoGenerateDuplicateGuardResult(
  sessionKey?: string,
): VideoGenerateActionResult | null {
  const activeTask = findActiveVideoGenerationTaskForSession(sessionKey);
  if (!activeTask) {
    return null;
  }
  return {
    content: [
      {
        type: "text",
        text: buildVideoGenerationTaskStatusText(activeTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...buildVideoGenerationTaskStatusDetails(activeTask),
    },
  };
}

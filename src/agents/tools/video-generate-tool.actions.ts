import type { OpenClawConfig } from "../../config/config.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
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
    const capabilities = [
      provider.capabilities.maxVideos ? `maxVideos=${provider.capabilities.maxVideos}` : null,
      provider.capabilities.maxInputImages
        ? `maxInputImages=${provider.capabilities.maxInputImages}`
        : null,
      provider.capabilities.maxInputVideos
        ? `maxInputVideos=${provider.capabilities.maxInputVideos}`
        : null,
      provider.capabilities.maxDurationSeconds
        ? `maxDurationSeconds=${provider.capabilities.maxDurationSeconds}`
        : null,
      provider.capabilities.supportedDurationSeconds?.length
        ? `supportedDurationSeconds=${provider.capabilities.supportedDurationSeconds.join("/")}`
        : null,
      provider.capabilities.supportedDurationSecondsByModel &&
      Object.keys(provider.capabilities.supportedDurationSecondsByModel).length > 0
        ? `supportedDurationSecondsByModel=${Object.entries(
            provider.capabilities.supportedDurationSecondsByModel,
          )
            .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
            .join("; ")}`
        : null,
      provider.capabilities.supportsResolution ? "resolution" : null,
      provider.capabilities.supportsAspectRatio ? "aspectRatio" : null,
      provider.capabilities.supportsSize ? "size" : null,
      provider.capabilities.supportsAudio ? "audio" : null,
      provider.capabilities.supportsWatermark ? "watermark" : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
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

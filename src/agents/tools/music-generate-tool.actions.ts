import type { OpenClawConfig } from "../../config/config.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import {
  buildMusicGenerationTaskStatusDetails,
  buildMusicGenerationTaskStatusText,
  findActiveMusicGenerationTaskForSession,
} from "../music-generation-task-status.js";

type MusicGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function getMusicGenerationProviderAuthEnvVars(providerId: string): string[] {
  return getProviderEnvVars(providerId);
}

export function createMusicGenerateListActionResult(
  config?: OpenClawConfig,
): MusicGenerateActionResult {
  const providers = listRuntimeMusicGenerationProviders({ config });
  if (providers.length === 0) {
    return {
      content: [{ type: "text", text: "No music-generation providers are registered." }],
      details: { providers: [] },
    };
  }
  const lines = providers.map((provider) => {
    const authHints = getMusicGenerationProviderAuthEnvVars(provider.id);
    const capabilities = [
      provider.capabilities.maxTracks ? `maxTracks=${provider.capabilities.maxTracks}` : null,
      provider.capabilities.maxInputImages
        ? `maxInputImages=${provider.capabilities.maxInputImages}`
        : null,
      provider.capabilities.maxDurationSeconds
        ? `maxDurationSeconds=${provider.capabilities.maxDurationSeconds}`
        : null,
      provider.capabilities.supportsLyrics ? "lyrics" : null,
      provider.capabilities.supportsInstrumental ? "instrumental" : null,
      provider.capabilities.supportsDuration ? "duration" : null,
      provider.capabilities.supportsFormat ? "format" : null,
      provider.capabilities.supportedFormats?.length
        ? `supportedFormats=${provider.capabilities.supportedFormats.join("/")}`
        : null,
      provider.capabilities.supportedFormatsByModel &&
      Object.keys(provider.capabilities.supportedFormatsByModel).length > 0
        ? `supportedFormatsByModel=${Object.entries(provider.capabilities.supportedFormatsByModel)
            .map(([modelId, formats]) => `${modelId}:${formats.join("/")}`)
            .join("; ")}`
        : null,
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
        authEnvVars: getMusicGenerationProviderAuthEnvVars(provider.id),
        capabilities: provider.capabilities,
      })),
    },
  };
}

export function createMusicGenerateStatusActionResult(
  sessionKey?: string,
): MusicGenerateActionResult {
  const activeTask = findActiveMusicGenerationTaskForSession(sessionKey);
  if (!activeTask) {
    return {
      content: [
        {
          type: "text",
          text: "No active music generation task is currently running for this session.",
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
        text: buildMusicGenerationTaskStatusText(activeTask),
      },
    ],
    details: {
      action: "status",
      ...buildMusicGenerationTaskStatusDetails(activeTask),
    },
  };
}

export function createMusicGenerateDuplicateGuardResult(
  sessionKey?: string,
): MusicGenerateActionResult | null {
  const activeTask = findActiveMusicGenerationTaskForSession(sessionKey);
  if (!activeTask) {
    return null;
  }
  return {
    content: [
      {
        type: "text",
        text: buildMusicGenerationTaskStatusText(activeTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...buildMusicGenerationTaskStatusDetails(activeTask),
    },
  };
}

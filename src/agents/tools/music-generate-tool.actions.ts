import type { OpenClawConfig } from "../../config/config.js";
import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
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

function summarizeMusicGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeMusicGenerationProviders>[number],
): string {
  const supportedModes = listSupportedMusicGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const edit = provider.capabilities.edit;
  const capabilities = [
    supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
    generate?.maxTracks ? `maxTracks=${generate.maxTracks}` : null,
    edit?.maxInputImages ? `maxInputImages=${edit.maxInputImages}` : null,
    generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
    generate?.supportsLyrics ? "lyrics" : null,
    generate?.supportsInstrumental ? "instrumental" : null,
    generate?.supportsDuration ? "duration" : null,
    generate?.supportsFormat ? "format" : null,
    generate?.supportedFormats?.length
      ? `supportedFormats=${generate.supportedFormats.join("/")}`
      : null,
    generate?.supportedFormatsByModel && Object.keys(generate.supportedFormatsByModel).length > 0
      ? `supportedFormatsByModel=${Object.entries(generate.supportedFormatsByModel)
          .map(([modelId, formats]) => `${modelId}:${formats.join("/")}`)
          .join("; ")}`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(", ");
  return capabilities;
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
    const capabilities = summarizeMusicGenerationCapabilities(provider);
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
        modes: listSupportedMusicGenerationModes(provider),
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

import type { OpenClawConfig } from "../../config/config.js";
import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import {
  buildMusicGenerationTaskStatusDetails,
  buildMusicGenerationTaskStatusText,
  findActiveMusicGenerationTaskForSession,
} from "../music-generation-task-status.js";
import {
  createMediaGenerateDuplicateGuardResult,
  createMediaGenerateStatusActionResult,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type MusicGenerateActionResult = MediaGenerateActionResult;

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
    const authHints = getProviderEnvVars(provider.id);
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
        authEnvVars: getProviderEnvVars(provider.id),
        capabilities: provider.capabilities,
      })),
    },
  };
}

export function createMusicGenerateStatusActionResult(
  sessionKey?: string,
): MusicGenerateActionResult {
  return createMediaGenerateStatusActionResult({
    sessionKey,
    inactiveText: "No active music generation task is currently running for this session.",
    findActiveTask: (activeSessionKey) =>
      findActiveMusicGenerationTaskForSession(activeSessionKey) ?? undefined,
    buildStatusText: buildMusicGenerationTaskStatusText,
    buildStatusDetails: buildMusicGenerationTaskStatusDetails,
  });
}

export function createMusicGenerateDuplicateGuardResult(
  sessionKey?: string,
): MusicGenerateActionResult | null {
  return createMediaGenerateDuplicateGuardResult({
    sessionKey,
    findActiveTask: (activeSessionKey) =>
      findActiveMusicGenerationTaskForSession(activeSessionKey) ?? undefined,
    buildStatusText: buildMusicGenerationTaskStatusText,
    buildStatusDetails: buildMusicGenerationTaskStatusDetails,
  });
}

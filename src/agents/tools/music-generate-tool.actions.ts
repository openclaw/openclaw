import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import {
  buildMusicGenerationTaskStatusDetails,
  buildMusicGenerationTaskStatusText,
  findActiveMusicGenerationTaskForSession,
  findDuplicateGuardMusicGenerationTaskForSession,
} from "../media-generation-task-status.js";
import {
  createMediaGenerateProviderListAction,
  createMediaGenerateTaskActions,
} from "./media-generate-tool-actions-shared.js";

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
    generate?.supportsLyricsByModel && Object.keys(generate.supportsLyricsByModel).length > 0
      ? `supportsLyricsByModel=${Object.entries(generate.supportsLyricsByModel)
          .map(([modelId, supported]) => `${modelId}:${supported}`)
          .join("; ")}`
      : null,
    generate?.supportsInstrumental ? "instrumental" : null,
    generate?.supportsInstrumentalByModel &&
    Object.keys(generate.supportsInstrumentalByModel).length > 0
      ? `supportsInstrumentalByModel=${Object.entries(generate.supportsInstrumentalByModel)
          .map(([modelId, supported]) => `${modelId}:${supported}`)
          .join("; ")}`
      : null,
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

export const createMusicGenerateListActionResult = createMediaGenerateProviderListAction({
  kind: "music_generation",
  listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  emptyText: "No music-generation providers are registered.",
  listModes: listSupportedMusicGenerationModes,
  summarizeCapabilities: summarizeMusicGenerationCapabilities,
});

export const {
  createStatusActionResult: createMusicGenerateStatusActionResult,
  createDuplicateGuardResult: createMusicGenerateDuplicateGuardResult,
} = createMediaGenerateTaskActions({
  inactiveText: "No active music generation task is currently running for this session.",
  findActiveTask: (sessionKey, agentId) =>
    findActiveMusicGenerationTaskForSession(sessionKey, { agentId }),
  // Prompt-only imports must not resolve duplicate guards until an action runs.
  findDuplicateTask: (sessionKey, request) =>
    findDuplicateGuardMusicGenerationTaskForSession(sessionKey, request),
  buildStatusText: buildMusicGenerationTaskStatusText,
  buildStatusDetails: buildMusicGenerationTaskStatusDetails,
});

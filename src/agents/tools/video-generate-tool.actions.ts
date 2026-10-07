import { listSupportedVideoGenerationModes } from "../../video-generation/capabilities.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  findDuplicateGuardVideoGenerationTaskForSession,
} from "../media-generation-task-status.js";
import {
  createMediaGenerateProviderListAction,
  createMediaGenerateTaskActions,
} from "./media-generate-tool-actions-shared.js";

function summarizeVideoGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeVideoGenerationProviders>[number],
  options?: { modes?: readonly string[]; includeModes?: boolean },
): string {
  const supportedModes = options?.modes ?? listSupportedVideoGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const imageToVideo = provider.capabilities.imageToVideo;
  const videoToVideo = provider.capabilities.videoToVideo;
  const activeModeCapabilities = [
    supportedModes.includes("generate") ? generate : undefined,
    supportedModes.includes("imageToVideo") && imageToVideo?.enabled ? imageToVideo : undefined,
    supportedModes.includes("videoToVideo") && videoToVideo?.enabled ? videoToVideo : undefined,
  ].filter((capabilities) => capabilities !== undefined);
  const maxDurationSeconds = activeModeCapabilities
    .map((capabilities) => capabilities.maxDurationSeconds)
    .find((value) => typeof value === "number");
  const supportedDurationSeconds = activeModeCapabilities
    .map((capabilities) => capabilities.supportedDurationSeconds)
    .find((value) => value && value.length > 0);
  const supportedDurationSecondsByModel = activeModeCapabilities
    .map((capabilities) => capabilities.supportedDurationSecondsByModel)
    .find((value) => value && Object.keys(value).length > 0);
  // Match the runtime's union of provider-level and mode-level options.
  const declaredProviderOptions = {
    ...provider.capabilities.providerOptions,
    ...generate?.providerOptions,
    ...imageToVideo?.providerOptions,
    ...videoToVideo?.providerOptions,
  };
  const maxInputAudios =
    generate?.maxInputAudios ??
    imageToVideo?.maxInputAudios ??
    videoToVideo?.maxInputAudios ??
    provider.capabilities.maxInputAudios;
  const capabilities = [
    options?.includeModes !== false && supportedModes.length > 0
      ? `modes=${supportedModes.join("/")}`
      : null,
    generate?.maxVideos ? `maxVideos=${generate.maxVideos}` : null,
    imageToVideo?.maxInputImages ? `maxInputImages=${imageToVideo.maxInputImages}` : null,
    videoToVideo?.maxInputVideos ? `maxInputVideos=${videoToVideo.maxInputVideos}` : null,
    typeof maxInputAudios === "number" && maxInputAudios > 0
      ? `maxInputAudios=${maxInputAudios}`
      : null,
    maxDurationSeconds ? `maxDurationSeconds=${maxDurationSeconds}` : null,
    supportedDurationSeconds
      ? `supportedDurationSeconds=${supportedDurationSeconds.join("/")}`
      : null,
    supportedDurationSecondsByModel
      ? `supportedDurationSecondsByModel=${Object.entries(supportedDurationSecondsByModel)
          .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
          .join("; ")}`
      : null,
    ...(
      [
        ["supportsResolution", "resolution"],
        ["supportsAspectRatio", "aspectRatio"],
        ["supportsSize", "size"],
        ["supportsAudio", "audio"],
        ["supportsWatermark", "watermark"],
      ] as const
    ).flatMap(([key, label]) =>
      activeModeCapabilities.some((capabilities) => capabilities[key]) ? [label] : [],
    ),
    Object.keys(declaredProviderOptions).length > 0
      ? `providerOptions={${Object.entries(declaredProviderOptions)
          .map(([key, type]) => `${key}:${type}`)
          .join(", ")}}`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(", ");
  return capabilities;
}

export const createVideoGenerateListActionResult = createMediaGenerateProviderListAction({
  kind: "video_generation",
  listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  emptyText: "No video-generation providers are registered.",
  listModes: listSupportedVideoGenerationModes,
  summarizeCapabilities: summarizeVideoGenerationCapabilities,
});

export const {
  createStatusActionResult: createVideoGenerateStatusActionResult,
  createDuplicateGuardResult: createVideoGenerateDuplicateGuardResult,
} = createMediaGenerateTaskActions({
  inactiveText: "No active video generation task is currently running for this session.",
  findActiveTask: (sessionKey, agentId) =>
    findActiveVideoGenerationTaskForSession(sessionKey, { agentId }),
  findDuplicateTask: (sessionKey, request) =>
    findDuplicateGuardVideoGenerationTaskForSession(sessionKey, request),
  buildStatusText: buildVideoGenerationTaskStatusText,
  buildStatusDetails: buildVideoGenerationTaskStatusDetails,
});

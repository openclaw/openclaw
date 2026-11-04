import type {
  MusicGenerationEditCapabilities,
  MusicGenerationMode,
  MusicGenerationModeCapabilities,
  MusicGenerationProviderCapabilities,
} from "./types.js";

/** List modes supported by a provider in stable display order. */
export function listSupportedMusicGenerationModes(provider: {
  capabilities: MusicGenerationProviderCapabilities;
}): MusicGenerationMode[] {
  const modes: MusicGenerationMode[] = ["generate"];
  const edit = provider.capabilities.edit;
  if (edit?.enabled) {
    modes.push("edit");
  }
  return modes;
}

/** Resolve the provider capability contract for one request. */
export function resolveMusicGenerationModeCapabilities(params: {
  provider: { capabilities: MusicGenerationProviderCapabilities };
  inputImageCount: number;
  model?: string;
}): MusicGenerationModeCapabilities | MusicGenerationEditCapabilities | undefined {
  const mode = params.provider.capabilities[params.inputImageCount > 0 ? "edit" : "generate"];
  if (!mode || !params.model) {
    return mode;
  }
  const supportsDuration = mode.supportsDurationByModel?.[params.model] ?? mode.supportsDuration;
  return "enabled" in mode
    ? {
        ...mode,
        supportsDuration,
        maxInputImages: mode.maxInputImagesByModel?.[params.model] ?? mode.maxInputImages,
      }
    : { ...mode, supportsDuration };
}

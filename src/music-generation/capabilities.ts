import type {
  MusicGenerationEditCapabilities,
  MusicGenerationMode,
  MusicGenerationModeCapabilities,
  MusicGenerationProvider,
} from "./types.js";

/** List modes supported by a provider in stable display order. */
export function listSupportedMusicGenerationModes(
  provider: Pick<MusicGenerationProvider, "capabilities">,
): MusicGenerationMode[] {
  const modes: MusicGenerationMode[] = ["generate"];
  const edit = provider.capabilities.edit;
  if (edit?.enabled) {
    modes.push("edit");
  }
  return modes;
}

/** Resolve the active mode and provider capability contract for one request. */
export function resolveMusicGenerationModeCapabilities(params: {
  provider?: Pick<MusicGenerationProvider, "capabilities">;
  inputImageCount?: number;
}): {
  mode: MusicGenerationMode;
  capabilities: MusicGenerationModeCapabilities | MusicGenerationEditCapabilities | undefined;
} {
  const mode = (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
  return {
    mode,
    capabilities: params.provider?.capabilities?.[mode],
  };
}

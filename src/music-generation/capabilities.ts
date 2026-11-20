import type {
  MusicGenerationEditCapabilities,
  MusicGenerationMode,
  MusicGenerationModeCapabilities,
  MusicGenerationProviderCapabilities,
} from "./types.js";

/** Validate an explicitly declared model duration without changing the caller's value. */
export function validateMusicGenerationDuration(params: {
  capabilities: MusicGenerationModeCapabilities;
  model: string;
  durationSeconds: number | undefined;
}): boolean {
  const constraint = params.capabilities.durationConstraintsByModel?.[params.model];
  const duration = params.durationSeconds;
  if (constraint === undefined) {
    return false;
  }
  if (duration === undefined) {
    return true;
  }
  if (constraint === false) {
    throw new Error(`${params.model} does not support durationSeconds.`);
  }
  if (
    !Number.isFinite(duration) ||
    duration < constraint.minSeconds ||
    duration > constraint.maxSeconds ||
    (constraint.integer && !Number.isInteger(duration))
  ) {
    throw new Error(
      `${params.model} requires durationSeconds between ${constraint.minSeconds} and ${constraint.maxSeconds}${constraint.integer ? " (integer seconds)" : ""}.`,
    );
  }
  return true;
}

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
}): MusicGenerationModeCapabilities | MusicGenerationEditCapabilities | undefined {
  return params.provider.capabilities[params.inputImageCount > 0 ? "edit" : "generate"];
}

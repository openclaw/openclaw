import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { positiveDurationError } from "../shared/positive-duration.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import type { VideoGenerationProvider } from "./types.js";

export function resolveVideoGenerationSupportedDurations(params: {
  provider?: VideoGenerationProvider;
  model?: string;
  inputImageCount?: number;
  inputVideoCount?: number;
}): number[] | undefined {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const model = params.model?.trim();
  const modelSpecific =
    model && caps?.supportedDurationSecondsByModel
      ? caps.supportedDurationSecondsByModel[model]
      : undefined;
  const values = modelSpecific ?? caps?.supportedDurationSeconds;
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const normalized = uniqueValues(values)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value))
    .filter((value) => value > 0)
    .toSorted((left, right) => left - right);
  return normalized.length > 0 ? normalized : undefined;
}

// Normalize requested duration for providers with explicit allowed values. Ties
// choose the longer duration to avoid shortening user intent unexpectedly.
export function normalizeVideoGenerationDuration(params: {
  provider?: VideoGenerationProvider;
  model?: string;
  durationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  inputImageCount?: number;
  inputVideoCount?: number;
}): number | undefined {
  if (params.durationSeconds === undefined) {
    return undefined;
  }
  const rounded = parseStrictPositiveInteger(Math.round(params.durationSeconds));
  if (rounded === undefined) {
    throw positiveDurationError("durationSeconds", "s");
  }
  const supported =
    params.supportedDurationSeconds ?? resolveVideoGenerationSupportedDurations(params);
  if (!supported || supported.length === 0) {
    return rounded;
  }
  return selectSupportedVideoDuration(rounded, supported);
}

/** Select from a nonempty duration list, preferring the longer value on ties. */
export function selectSupportedVideoDuration(
  durationSeconds: number,
  supported: readonly number[],
): number {
  return supported.reduce((best, current) => {
    const currentDistance = Math.abs(current - durationSeconds);
    const bestDistance = Math.abs(best - durationSeconds);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

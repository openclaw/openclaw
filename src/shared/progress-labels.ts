import { fnv1aUtf16 } from "./fnv1a.js";

const DEFAULT_PROGRESS_DRAFT_LABELS = ["Working"] as const;

export function selectProgressLabel(params: {
  labels?: readonly string[];
  seed?: string;
  random?: () => number;
}): string | undefined {
  const labels = params.labels ?? DEFAULT_PROGRESS_DRAFT_LABELS;
  if (labels.length === 0) {
    return undefined;
  }
  const index =
    params.seed && params.seed.length > 0
      ? fnv1aUtf16(params.seed) % labels.length
      : Math.floor(Math.max(0, Math.min(0.999999, params.random?.() ?? 0)) * labels.length);
  return labels[index] ?? labels[0];
}

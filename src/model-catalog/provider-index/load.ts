import { normalizeOpenClawProviderIndex } from "./normalize.js";
import { OPENCLAW_PROVIDER_INDEX } from "./openclaw-provider-index.js";
import type { OpenClawProviderIndex } from "./types.js";

/** Loads the bundled provider index, returning an empty v1 index if normalization fails. */
export function loadOpenClawProviderIndex(
  source: unknown = OPENCLAW_PROVIDER_INDEX,
): OpenClawProviderIndex {
  return normalizeOpenClawProviderIndex(source) ?? { version: 1, providers: {} };
}

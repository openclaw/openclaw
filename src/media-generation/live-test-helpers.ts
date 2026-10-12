import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

type LiveProviderModelConfig =
  | string
  | {
      primary?: string;
      fallbacks?: readonly string[];
    }
  | undefined;

/** Redacts live API keys without retaining credential-derived text in test output. */
export function redactLiveApiKey(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "none";
  }
  return "<redacted>";
}

/** Parses comma-separated live-test filters; null means "all". */
export function parseLiveCsvFilter(
  raw?: string,
  options: { lowercase?: boolean } = {},
): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const values = trimmed
    .split(",")
    .map((entry) =>
      options.lowercase === false ? entry.trim() : normalizeOptionalLowercaseString(entry),
    )
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? new Set(values) : null;
}

/** Parses provider/model refs keyed by normalized provider id. */
export function parseProviderModelMap(raw?: string): Map<string, string> {
  return parseProviderModelRefs(raw?.split(",") ?? []);
}

function parseProviderModelRefs(refs: readonly (string | undefined)[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const token of refs) {
    const trimmed = token?.trim();
    if (!trimmed) {
      continue;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      continue;
    }
    const providerId = normalizeOptionalLowercaseString(trimmed.slice(0, slash));
    if (!providerId) {
      continue;
    }
    entries.set(providerId, trimmed);
  }
  return entries;
}

/** Collects primary/fallback provider model refs from live-test config. */
export function resolveConfiguredLiveProviderModels(
  configured: LiveProviderModelConfig,
): Map<string, string> {
  return parseProviderModelRefs(
    typeof configured === "string"
      ? [configured]
      : [configured?.primary, ...(configured?.fallbacks ?? [])],
  );
}

/** Returns an empty auth store only when live env keys may be used directly. */
export function resolveLiveAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}): AuthProfileStore | undefined {
  if (params.requireProfileKeys || !params.hasLiveKeys) {
    return undefined;
  }
  return {
    version: 1,
    profiles: {},
  };
}

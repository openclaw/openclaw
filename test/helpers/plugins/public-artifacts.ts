import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../../../src/plugins/runtime-sidecar-paths.js";

function assertUniqueValues<T extends string>(values: readonly T[], label: string): readonly T[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate ${label}: ${Array.from(duplicates).join(", ")}`);
  }
  return values;
}

export function getPublicArtifactBasename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

const EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues(
  [
    "action-runtime.runtime.js",
    "action-runtime-api.js",
    "allow-from.js",
    "api.js",
    "auth-presence.js",
    "channel-config-api.js",
    "index.js",
    "login-qr-api.js",
    "onboard.js",
    "openai-codex-catalog.js",
    "provider-catalog.js",
    "session-key-api.js",
    "setup-api.js",
    "setup-entry.js",
    "timeouts.js",
    "x-search.js",
  ] as const,
  "extra guarded extension public surface basename",
);

export const BUNDLED_RUNTIME_SIDECAR_BASENAMES = assertUniqueValues(
  [...new Set(BUNDLED_RUNTIME_SIDECAR_PATHS.map(getPublicArtifactBasename))],
  "bundled runtime sidecar basename",
);

export const GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues(
  [...BUNDLED_RUNTIME_SIDECAR_BASENAMES, ...EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES],
  "guarded extension public surface basename",
);

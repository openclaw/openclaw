// Cache for build-info version to avoid repeated fetches
let cachedVersion: string | null = null;
let versionFetchPromise: Promise<string | null> | null = null;

/**
 * Reads the version from /dist/build-info.json.
 * Returns null if the file cannot be read or doesn't contain a version.
 * Uses a cache to avoid repeated fetches.
 */
export async function readBuildInfoVersion(): Promise<string | null> {
  // Return cached version if available
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  // Return existing promise if fetch is in progress
  if (versionFetchPromise !== null) {
    return versionFetchPromise;
  }

  // Start fetching
  versionFetchPromise = (async () => {
    try {
      // Try to read from /dist/build-info.json
      // The base path is inferred from the current location
      const basePath = window.__OPENCLAW_CONTROL_UI_BASE_PATH__ || "";
      const buildInfoPath = `${basePath}/dist/build-info.json`;
      const response = await fetch(buildInfoPath, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { version?: string };
      const version = data.version?.trim();
      if (version) {
        cachedVersion = version;
        return version;
      }
      return null;
    } catch {
      // Silently fail and return null
      return null;
    } finally {
      // Clear the promise so we can retry if needed
      versionFetchPromise = null;
    }
  })();

  return versionFetchPromise;
}

/**
 * Gets the cached version if available, or null.
 * Does not trigger a fetch.
 */
export function getCachedBuildInfoVersion(): string | null {
  return cachedVersion;
}

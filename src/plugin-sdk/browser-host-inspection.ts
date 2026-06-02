import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export type BrowserExecutable = {
  /** Browser family detected for the executable path. */
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  /** Absolute executable path used by browser launch/doctor code. */
  path: string;
};

type BrowserHostInspectionSurface = {
  resolveGoogleChromeExecutableForPlatform: (platform: NodeJS.Platform) => BrowserExecutable | null;
  readBrowserVersion: (executablePath: string) => string | null;
  parseBrowserMajorVersion: (rawVersion: string | null | undefined) => number | null;
};

let cachedBrowserHostInspectionSurface: BrowserHostInspectionSurface | undefined;

function loadBrowserHostInspectionSurface(): BrowserHostInspectionSurface {
  // The bundled browser plugin surface is process-stable; cache it so repeated doctor/runtime
  // probes do not rediscover the generated facade module.
  cachedBrowserHostInspectionSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserHostInspectionSurface>({
      dirName: "browser",
      artifactBasename: "browser-host-inspection.js",
    });
  return cachedBrowserHostInspectionSurface;
}

/** Resolves the preferred Google Chrome-compatible executable for a platform. */
export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  return loadBrowserHostInspectionSurface().resolveGoogleChromeExecutableForPlatform(platform);
}

/** Reads a browser executable version string using the bundled browser inspection surface. */
export function readBrowserVersion(executablePath: string): string | null {
  return loadBrowserHostInspectionSurface().readBrowserVersion(executablePath);
}

/** Parses the major browser version from a raw executable version string. */
export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  return loadBrowserHostInspectionSurface().parseBrowserMajorVersion(rawVersion);
}

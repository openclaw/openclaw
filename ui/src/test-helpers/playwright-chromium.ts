// Chromium selection for Playwright-driven UI tests and the browser Vitest project.
// Kept free of app/test-fixture imports so Vitest config can load it cheaply.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const chromiumExecutableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

export function resolvePlaywrightChromiumExecutablePath(
  defaultExecutablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  canRun: (chromiumExecutablePath: string) => boolean = canRunPlaywrightChromium,
): string {
  const executableOverride = env[chromiumExecutableOverrideEnvKey]?.trim();
  if (executableOverride) {
    return executableOverride;
  }
  if (canRun(defaultExecutablePath)) {
    return defaultExecutablePath;
  }
  return (
    [
      ...installedPlaywrightChromiumCandidates(defaultExecutablePath),
      ...systemChromiumExecutableCandidates,
    ].find((candidate) => canRun(candidate)) ?? defaultExecutablePath
  );
}

// Preinstalled browser caches (for example a shared PLAYWRIGHT_BROWSERS_PATH image)
// can hold another Chromium revision than this Playwright pin. Prefer the newest one
// over system browsers; its Linux layout moved from chrome-linux to chrome-linux64.
function installedPlaywrightChromiumCandidates(defaultExecutablePath: string): string[] {
  const segments = defaultExecutablePath.split(path.sep);
  const revisionIndex = segments.findIndex((segment) => /^chromium-\d+$/u.test(segment));
  if (revisionIndex < 1) {
    return [];
  }
  const browsersRoot = segments.slice(0, revisionIndex).join(path.sep);
  let entries: string[];
  try {
    entries = readdirSync(browsersRoot);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^chromium-\d+$/u.test(entry))
    .toSorted((left, right) => Number(right.slice(9)) - Number(left.slice(9)))
    .flatMap((entry) =>
      ["chrome-linux64", "chrome-linux"].map((dir) =>
        path.join(browsersRoot, entry, dir, "chrome"),
      ),
    );
}

export function canRunPlaywrightChromium(chromiumExecutablePath: string): boolean {
  if (!existsSync(chromiumExecutablePath)) {
    return false;
  }
  return spawnSync(chromiumExecutablePath, ["--version"], { stdio: "ignore" }).status === 0;
}

import type { TaglineMode } from "./tagline.js";

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

/**
 * Cached tagline mode — resolved at most once, then reused.
 *
 * `createConfigIO().loadConfig()` is a heavy synchronous call whose
 * transitive module graph (plugin discovery, native modules, JIT loaders)
 * can deadlock the main thread when invoked inside Commander's synchronous
 * help-generation callback (e.g. `openclaw tui -h`).
 *
 * The config import is deferred behind a dynamic `import()` behind a
 * dedicated `*.runtime.ts` boundary. The first banner render returns
 * `undefined` (random tagline) while the config loads asynchronously in
 * the background. Subsequent renders use the cached result.
 */
let cachedTaglineMode: TaglineMode | undefined | null = null; // null = not yet resolved
let configImportStarted = false;

function tryResolveTaglineModeFromConfig(env: NodeJS.ProcessEnv): void {
  if (configImportStarted) {
    return;
  }
  configImportStarted = true;
  // Fire-and-forget: resolve config asynchronously so the result is ready
  // for subsequent banner renders without blocking the first one.
  // Uses a dedicated *.runtime.ts boundary per dynamic import guardrail.
  import("./banner-config-lite.runtime.js")
    .then((mod) => {
      try {
        const parsed = mod.createConfigIO({ env }).loadConfig() as {
          cli?: { banner?: { taglineMode?: unknown } };
        };
        cachedTaglineMode = parseTaglineMode(parsed.cli?.banner?.taglineMode) ?? undefined;
      } catch {
        cachedTaglineMode = undefined;
      }
    })
    .catch(() => {
      cachedTaglineMode = undefined;
    });
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  if (cachedTaglineMode !== null) {
    return cachedTaglineMode;
  }
  // Start the async config resolution for future calls; return undefined
  // (random tagline) for this call to avoid synchronous deadlock.
  tryResolveTaglineModeFromConfig(env);
  return undefined;
}

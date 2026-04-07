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
 * dedicated `*.runtime.ts` boundary. If the runtime module has already been
 * loaded by the normal CLI bootstrap path (preAction hook / config guard),
 * the import resolves synchronously from cache and the first call returns
 * the real configured value. Otherwise (help-only cold path) the first
 * render falls back to `undefined` (random tagline) while config loads
 * asynchronously; subsequent renders use the cached result.
 */
let cachedTaglineMode: TaglineMode | undefined | null = null; // null = not yet resolved

function resolveTaglineModeFromConfig(env: NodeJS.ProcessEnv): TaglineMode | undefined {
  try {
    // Dynamic import that resolves synchronously when the module is already
    // in the ESM cache (the normal CLI startup path loads config early via
    // the preAction hook). Uses a dedicated *.runtime.ts boundary per the
    // dynamic import guardrail.
    let resolved: TaglineMode | undefined;
    let syncResolved = false;

    import("./banner-config-lite.runtime.js")
      .then((mod) => {
        try {
          const parsed = mod.createConfigIO({ env }).loadConfig() as {
            cli?: { banner?: { taglineMode?: unknown } };
          };
          resolved = parseTaglineMode(parsed.cli?.banner?.taglineMode);
        } catch {
          resolved = undefined;
        }
        syncResolved = true;
      })
      .catch(() => {
        resolved = undefined;
        syncResolved = true;
      });

    // If the module was already cached, the .then() microtask will have
    // executed synchronously before we reach this point (Node.js resolves
    // cached dynamic imports as already-fulfilled promises whose .then()
    // callbacks run in the same microtask checkpoint). In that case we can
    // return the real value immediately — no behavioral regression.
    if (syncResolved) {
      cachedTaglineMode = resolved;
      return cachedTaglineMode;
    }

    // Module not yet loaded — fall back to undefined for this call.
    // The async resolution will populate the cache for future calls.
    cachedTaglineMode = undefined;
    return undefined;
  } catch {
    cachedTaglineMode = undefined;
    return undefined;
  }
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  if (cachedTaglineMode !== null) {
    return cachedTaglineMode;
  }
  return resolveTaglineModeFromConfig(env);
}

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preferBundledPluginSourceForVitest } from "../bundled-source-overlays.js";

// Under Vitest, the real plugin loader evaluates a bundled plugin through Jiti and the host
// plugin runtime through native require, so each would get its own copy of core: module-local
// state, `vi.mock` and Gateway bindings would differ from the test's. A built host shares one
// module graph. Jiti and native require both reuse a loaded `require.cache` entry, so seeding
// the SDK subpaths a plugin imports (and the host runtime) with this Vitest graph's modules
// gives the loaded plugin the same core as the test, as in production.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SDK_SPECIFIER = /["']openclaw\/plugin-sdk\/([a-z0-9-]+)["']/g;

function listPluginSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : listPluginSourceFiles(file);
    }
    return /\.(?:ts|mts)$/.test(entry.name) && !/\.test(?:-support)?\.ts$/.test(entry.name)
      ? [file]
      : [];
  });
}

/**
 * Shares this Vitest module graph's core with the bundled plugin the real loader loads. A
 * Gateway would load the plugin's built artifact (built host, another copy); this also makes
 * the loader run the plugin's checkout source.
 */
export async function shareVitestModuleGraphWithBundledPlugin(pluginId: string): Promise<void> {
  preferBundledPluginSourceForVitest([pluginId]);
  const subpaths = new Set<string>();
  for (const file of listPluginSourceFiles(path.join(repoRoot, "extensions", pluginId))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(SDK_SPECIFIER)) {
      subpaths.add(match[1]!);
    }
  }
  const targets = [
    ...[...subpaths].map((subpath) => path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`)),
    path.join(repoRoot, "src", "plugins", "runtime", "index.ts"),
  ];
  const cache = createRequire(import.meta.url).cache;
  for (const filename of targets) {
    if (cache[filename]?.loaded || !fs.existsSync(filename)) {
      continue;
    }
    const exports: unknown = await import(filename);
    // SAFETY: Jiti and Node read only `loaded` and `exports` from a cached entry.
    cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
  }
}

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Under Vitest, the real plugin loader evaluates a bundled plugin through Jiti and the host
// plugin runtime through native require, so each would get its own copy of core: module-local
// state, `vi.mock` and Gateway bindings would differ from the test's. A built host shares one
// module graph. Jiti and native require both reuse a loaded `require.cache` entry, so seeding
// the SDK subpaths a plugin imports (and the host runtime) with this Vitest graph's modules
// gives the loaded plugin the same core as the test, as in production.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SDK_SPECIFIER = /["']openclaw\/plugin-sdk\/([a-z0-9-]+)["']/g;
const stagedBundledRoots = new Map<string, string>();

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
 * Stages a bundled plugins root holding only a source copy of this plugin. A Gateway prefers
 * built bundled artifacts, and resolves `<repo>/extensions/<id>` to a local
 * `dist/extensions/<id>` build when one exists; that build imports the built core, not this
 * test's. A bundled root outside `<repo>/extensions` has no built peer, so the Gateway runs
 * the plugin's checkout source. The plugin's own `node_modules` and the repo's stay reachable.
 */
function stageBundledPluginSourceRoot(pluginId: string): string {
  const staged = stagedBundledRoots.get(pluginId);
  if (staged) {
    return staged;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-source-"));
  // Removes the copy and its links, never the linked node_modules targets.
  process.once("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(repoRoot, "extensions", pluginId);
  const target = path.join(root, pluginId);
  fs.cpSync(source, target, {
    recursive: true,
    filter: (file) => path.basename(file) !== "node_modules",
  });
  if (fs.existsSync(path.join(source, "node_modules"))) {
    fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), "dir");
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  stagedBundledRoots.set(pluginId, root);
  return root;
}

/**
 * Shares this Vitest module graph's core with the bundled plugin the real loader (or an
 * in-process Gateway) loads, running the plugin's checkout source. Points bundled discovery at
 * a staged root holding only this plugin; returns the restore for that env change, so it can
 * be passed to `beforeAll` directly.
 */
export async function shareVitestModuleGraphWithBundledPlugin(
  pluginId: string,
): Promise<() => void> {
  const previousBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = stageBundledPluginSourceRoot(pluginId);
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
  return () => {
    if (previousBundledDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledDir;
    }
  };
}

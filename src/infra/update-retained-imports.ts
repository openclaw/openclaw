import fs from "node:fs";
import Module, { createRequire, type ResolveFnOutput } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { useNodeModuleHooks } from "../plugins/native-module-require.js";
import { UPDATE_PRELOAD_IMPORTS_FILE } from "./update-retained-imports-contract.js";
import {
  prepareRuntimeRelocations,
  relocateRuntimePath,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

// Formats the ESM loader instantiates from load-hook source under the resolved URL.
const ESM_LOADER_FORMATS = new Set(["module", "json", "wasm"]);

function specifierPath(specifier: string | undefined): string | undefined {
  if (specifier?.startsWith("file:")) {
    return fileURLToPath(specifier);
  }
  return specifier && path.isAbsolute(specifier) ? specifier : undefined;
}

/** Move a file URL to another pathname; query and fragment remain part of ESM identity. */
function movedFileUrl(file: string, from: string): string {
  const url = pathToFileURL(file);
  if (from.startsWith("file:")) {
    const { search, hash } = new URL(from);
    url.search = search;
    url.hash = hash;
  }
  return url.href;
}

/**
 * Whether a retained file is an ES module, judged from the retained package
 * alone. Require resolution reports no format, and ESM resolution defers
 * typeless `.js` until loading; Node then detects ESM syntax that cannot
 * compile as CommonJS.
 */
function isRetainedEsModule(file: string): boolean {
  const extension = path.extname(file);
  if (extension === ".mjs") {
    return true;
  }
  if (extension !== ".js") {
    return false;
  }
  const manifest = Module.findPackageJSON(pathToFileURL(file));
  const type = manifest
    ? (JSON.parse(fs.readFileSync(manifest, "utf8")) as { type?: unknown }).type
    : undefined;
  if (type === "module" || type === "commonjs") {
    return type === "module";
  }
  try {
    vm.compileFunction(fs.readFileSync(file, "utf8"), [
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
    ]);
    return false;
  } catch {
    return true;
  }
}

/**
 * Serve the running updater's later module loads from its retained runtime.
 *
 * Package replacement removes or rewrites the updater's hashed chunks and
 * dependencies, so a lazy import after the swap would otherwise reach the
 * candidate tree. Resolution always runs against the retained copy. ES modules
 * keep their installed URL and receive retained bytes from the load hook, so
 * modules imported before the swap are reused rather than instantiated twice
 * and `import.meta.url` keeps its install spelling. The CommonJS loader and
 * dlopen read the resolved pathname themselves, deciding a `.js` file's format
 * from its package before load hooks run; CommonJS modules and addons therefore
 * load from their retained path unless the installed module is already cached.
 * The hooks stay for the rest of this thread because the retained directory
 * outlives the command and post-command drains still import lazily.
 *
 * Bun keeps its native resolver (see `useNodeModuleHooks`), so it returns
 * false there and the caller preloads instead.
 */
export function serveUpdaterImportsFromRetainedRuntime(params: {
  /** Install paths, including spellings Node may use in module URLs, to retained paths. */
  relocations: readonly RuntimeRelocation[];
  /** Retained real paths back to the install paths Node assigned before replacement. */
  origins: readonly RuntimeRelocation[];
}): boolean {
  if (!useNodeModuleHooks()) {
    return false;
  }
  const forward = prepareRuntimeRelocations(params.relocations);
  const reverse = prepareRuntimeRelocations(params.origins);
  const requireCache = createRequire(import.meta.url).cache;
  const retained = (file: string | undefined) => {
    if (!file) {
      return undefined;
    }
    const moved = relocateRuntimePath(file, forward);
    return moved === file ? undefined : moved;
  };
  // Retained files are an immutable snapshot, so their classification is too.
  const esModules = new Map<string, boolean>();
  const retainedEsModule = (file: string) => {
    let esm = esModules.get(file);
    if (esm === undefined) {
      esm = isRetainedEsModule(file);
      esModules.set(file, esm);
    }
    return esm;
  };
  const withIdentity = (resolved: ResolveFnOutput): ResolveFnOutput => {
    if (!resolved.url.startsWith("file:")) {
      return resolved;
    }
    const file = fileURLToPath(resolved.url);
    const installed = relocateRuntimePath(file, reverse);
    if (installed === file) {
      return resolved;
    }
    const esm = resolved.format ? ESM_LOADER_FORMATS.has(resolved.format) : retainedEsModule(file);
    if (!esm && requireCache[installed] === undefined) {
      return resolved;
    }
    return {
      ...resolved,
      url: movedFileUrl(installed, resolved.url),
      // The installed pathname's package may now declare another module type.
      ...(esm && !resolved.format ? { format: "module" } : {}),
    };
  };
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Module.isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      // Hook chains merge a forwarded context into the shared one; keep the
      // installed context for the fallback.
      const installed = { ...context };
      const parent = retained(specifierPath(context.parentURL));
      // Absolute requests (`new URL(..., import.meta.url)`, `__dirname` joins)
      // name the installed tree directly, so they move with it.
      const target = retained(specifierPath(specifier));
      const base = parent ?? target;
      if (base) {
        try {
          // CommonJS resolution follows the parent module's own lookup paths
          // rather than parentURL, so resolve it from the retained parent directly.
          const resolved: ResolveFnOutput = context.conditions.includes("require")
            ? { url: pathToFileURL(createRequire(base).resolve(target ?? specifier)).href }
            : nextResolve(target ? movedFileUrl(target, specifier) : specifier, {
                ...context,
                ...(parent ? { parentURL: pathToFileURL(parent).href } : {}),
              });
          return { ...withIdentity(resolved), shortCircuit: true };
        } catch {
          // Files outside the retained roots keep their installed resolution.
        }
      }
      // A module already loaded from the retained tree resolves inside it; its
      // dependencies still join modules cached under their installed identity.
      return withIdentity(nextResolve(specifier, installed));
    },
    load(url, context, nextLoad) {
      const file = retained(specifierPath(url));
      if (!file || !fs.existsSync(file)) {
        return nextLoad(url, context);
      }
      const loaded = nextLoad(pathToFileURL(file).href, context);
      // require() picks a `.js` format from the installed package before loading.
      return path.extname(file) === ".js" &&
        (loaded.format === "module" || loaded.format === "commonjs")
        ? { ...loaded, format: retainedEsModule(file) ? "module" : "commonjs" }
        : loaded;
    },
  });
  return true;
}

/**
 * Load every chunk the updater can import after package replacement while the
 * installed bytes are still in place, for runtimes without module hooks.
 *
 * Bun keeps evaluated modules in its registry keyed by real path, so a later
 * `import()` of the same chunk returns the loaded module instead of reading the
 * replaced tree. The build lists the chunks; packages without the list (source
 * checkouts that were never built, older releases) keep their bridges.
 */
export async function preloadUpdaterPostSwapImports(packageRoot: string): Promise<boolean> {
  const distDir = path.join(packageRoot, "dist");
  let listed: unknown;
  try {
    listed = JSON.parse(fs.readFileSync(path.join(distDir, UPDATE_PRELOAD_IMPORTS_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const chunks = (listed as { chunks?: unknown }).chunks;
  if (
    !Array.isArray(chunks) ||
    !chunks.every(
      (chunk) =>
        typeof chunk === "string" &&
        !path.isAbsolute(chunk) &&
        !chunk.split("/").includes("..") &&
        /\.m?js$/u.test(chunk),
    )
  ) {
    throw new Error(`Invalid updater preload list ${UPDATE_PRELOAD_IMPORTS_FILE}`);
  }
  for (const chunk of chunks) {
    await import(pathToFileURL(path.join(distDir, chunk)).href);
  }
  return true;
}

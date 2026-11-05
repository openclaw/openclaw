import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { escapeRegExp } from "../shared/regexp.js";
import { isNativeEsmPackage } from "./native-module-format.js";
import {
  prepareRuntimeRelocations,
  relocateRuntimePath,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

type RetainedSourceLoader = "js" | "jsx" | "ts" | "tsx";
type RetainedBunRuntime = {
  resolveSync(specifier: string, parent: string): string;
  plugin(plugin: {
    name: string;
    setup(builder: {
      onResolve(
        options: { filter: RegExp; namespace: "file" },
        resolve: (args: {
          path: string;
          importer: string;
          kind: string;
        }) => { path: string; namespace: "file" } | undefined,
      ): void;
      onLoad(
        options: { filter: RegExp; namespace: "file" },
        load: () =>
          | { contents: Buffer; loader: RetainedSourceLoader }
          | { exports: Record<string, unknown>; loader: "object" },
      ): void;
    }): void;
  }): void;
};

const retainedSourceLoaders: Readonly<Record<string, RetainedSourceLoader>> = {
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};

/** Keep module identity and import.meta.url while loading the retained generation's bytes. */
export function retainUpdateRuntimeImports(
  relocations: readonly RuntimeRelocation[],
  files: Iterable<string>,
): void {
  const prepared = prepareRuntimeRelocations(relocations);
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const loads = new Map<string, string>();
  for (const file of files) {
    const original = pathToFileURL(file).href;
    const retained = pathToFileURL(relocateRuntimePath(file, prepared)).href;
    forward.set(original, retained);
    reverse.set(retained, original);
  }
  const relocateUrl = (value: string, mapping: ReadonlyMap<string, string>) => {
    if (!value.startsWith("file:")) {
      return value;
    }
    const url = new URL(value);
    const search = url.search;
    const hash = url.hash;
    url.search = "";
    url.hash = "";
    const relocated = mapping.get(url.href);
    if (!relocated) {
      return value;
    }
    const result = new URL(relocated);
    result.search = search;
    result.hash = hash;
    return result.href;
  };
  // CLI resource disposal runs after the update command returns. Keep this
  // process on its original generation through teardown; new code runs in children.
  if (process.versions.bun) {
    // SAFETY: Bun exposes these documented APIs whenever process.versions.bun is set.
    const bun = (globalThis as typeof globalThis & { Bun: RetainedBunRuntime }).Bun;
    const require = Module.createRequire(import.meta.url);
    // Bun returns relative-import query suffixes in its resolved file path.
    const bunFileUrl = (filename: string) => {
      const direct = pathToFileURL(filename).href;
      return forward.has(direct) || reverse.has(direct)
        ? direct
        : new URL(filename, "file:///").href;
    };
    let resolving = false;
    bun.plugin({
      name: "openclaw-retained-update-runtime",
      setup(builder) {
        builder.onResolve(
          { filter: /.*/, namespace: "file" },
          ({ path: specifier, importer, kind }) => {
            const importerUrl = bunFileUrl(importer);
            const relocatedParent = relocateUrl(importerUrl, forward);
            const parent =
              relocatedParent !== importerUrl
                ? relocatedParent
                : relocateUrl(importerUrl, reverse) !== importerUrl
                  ? importerUrl
                  : undefined;
            if (!parent || resolving) {
              return undefined;
            }
            const target = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
            // Native CommonJS loading explicitly enters the retained physical file.
            if (reverse.has(target)) {
              return undefined;
            }
            let resolved: string;
            resolving = true;
            try {
              const retainedTarget = relocateUrl(target, forward);
              resolved =
                kind === "require-call" || kind === "require-resolve"
                  ? Module.createRequire(parent).resolve(
                      retainedTarget.startsWith("file:")
                        ? fileURLToPath(retainedTarget)
                        : retainedTarget,
                    )
                  : bun.resolveSync(retainedTarget, path.dirname(fileURLToPath(parent)));
            } finally {
              resolving = false;
            }
            const retained = bunFileUrl(resolved);
            const original = relocateUrl(retained, reverse);
            if (original !== retained) {
              const originalUrl = new URL(original);
              const filename = fileURLToPath(originalUrl);
              const modulePath = filename + originalUrl.search + originalUrl.hash;
              if (path.extname(filename) === ".node") {
                return { path: require.cache[filename] ? filename : resolved, namespace: "file" };
              }
              if (!loads.has(original)) {
                const source = fileURLToPath(retained);
                builder.onLoad(
                  { filter: new RegExp(`^${escapeRegExp(modulePath)}$`), namespace: "file" },
                  () => {
                    const extension = path.extname(source);
                    const commonJs =
                      extension === ".cjs" ||
                      extension === ".cts" ||
                      ([".js", ".ts"].includes(extension) && !isNativeEsmPackage(source));
                    if (extension === ".json" || commonJs) {
                      const value: unknown = commonJs
                        ? require(source)
                        : JSON.parse(fs.readFileSync(source, "utf8"));
                      const names =
                        value !== null &&
                        (typeof value === "object" || typeof value === "function") &&
                        !Array.isArray(value)
                          ? value
                          : {};
                      return {
                        exports: { ...names, default: value, __esModule: true },
                        loader: "object",
                      };
                    }
                    return {
                      contents: fs.readFileSync(source),
                      loader: retainedSourceLoaders[extension] ?? "js",
                    };
                  },
                );
                loads.set(original, retained);
              }
              return { path: modulePath, namespace: "file" };
            }
            return { path: resolved, namespace: "file" };
          },
        );
      },
    });
    return;
  }
  let resolving = false;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (resolving) {
        return nextResolve(specifier, context);
      }
      const parentURL = context.parentURL && relocateUrl(context.parentURL, forward);
      if (!parentURL || parentURL === context.parentURL) {
        return nextResolve(specifier, context);
      }
      const target = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
      let retainedTarget = relocateUrl(target, forward);
      if (context.conditions.includes("require")) {
        // Node's CJS resolver retains its original parent despite a changed parentURL.
        resolving = true;
        try {
          retainedTarget = Module.createRequire(parentURL).resolve(
            retainedTarget.startsWith("file:") ? fileURLToPath(retainedTarget) : retainedTarget,
          );
        } finally {
          resolving = false;
        }
      }
      const result = nextResolve(retainedTarget, { ...context, parentURL });
      const url = relocateUrl(result.url, reverse);
      if (url !== result.url) {
        loads.set(url, result.url);
      }
      return { ...result, url };
    },
    load(url, context, nextLoad) {
      return nextLoad(loads.get(url) ?? url, context);
    },
  });
}

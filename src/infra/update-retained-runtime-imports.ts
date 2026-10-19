import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareRuntimeRelocations,
  relocateRuntimePath,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

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
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentURL = context.parentURL && relocateUrl(context.parentURL, forward);
      if (parentURL === context.parentURL) {
        return nextResolve(specifier, context);
      }
      const target = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
      const result = nextResolve(relocateUrl(target, forward), { ...context, parentURL });
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

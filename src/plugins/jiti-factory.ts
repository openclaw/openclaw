import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import type { createJiti as JitiFactory } from "jiti";

declare global {
  // The standalone bootstrap supplies the transform factory without loading it eagerly.
  var openclawStandaloneLoadJitiFactory: (() => typeof JitiFactory) | undefined;
}

let factory: typeof JitiFactory | undefined;

/** Keep Babel's lazy require inside Jiti's CJS module, where native resolver hooks retain its parent. */
export const createJiti: typeof JitiFactory = (...args) => {
  if (!factory) {
    const loadStandaloneFactory = globalThis.openclawStandaloneLoadJitiFactory;
    if (loadStandaloneFactory) {
      factory = loadStandaloneFactory();
    } else {
      const entry = moduleResolve("jiti", new URL(import.meta.url), new Set(["node", "require"]));
      const loaded: typeof import("jiti") = createRequire(import.meta.url)(fileURLToPath(entry));
      factory = loaded.createJiti;
    }
  }
  return factory(...args);
};

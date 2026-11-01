import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import type { createJiti as JitiFactory } from "jiti";

/* oxlint-disable typescript/unbound-method -- Save/restore V8's formatter callback by identity, without invoking it. */

declare global {
  // The standalone bootstrap supplies the transform factory without loading it eagerly.
  var openclawStandaloneLoadJitiFactory: (() => typeof JitiFactory) | undefined;
}

let factory: typeof JitiFactory | undefined;
let babelPrepareStackTrace: typeof Error.prepareStackTrace;

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
  const loader = factory(...args);
  const transform = loader.options.transform;
  if (transform && !args[1]?.transform) {
    loader.options.transform = (options) => {
      const previous = Error.prepareStackTrace;
      try {
        if (babelPrepareStackTrace) {
          Error.prepareStackTrace = babelPrepareStackTrace;
        }
        const result = transform(options);
        babelPrepareStackTrace = Error.prepareStackTrace;
        // Babel filters compiler frames lazily; finish diagnostics before leaving its scope.
        if (result.error instanceof Error) {
          void result.error.stack;
        }
        return result;
      } finally {
        Error.prepareStackTrace = previous;
      }
    };
  }
  return loader;
};

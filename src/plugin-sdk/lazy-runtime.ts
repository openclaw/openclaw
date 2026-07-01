/**
 * Public SDK subpath for lazy runtime module and method binding helpers.
 */
export {
  createLazyPromise,
  createLazyPromiseLoader,
  createLazyRuntimeModule,
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeNamedExport,
  createLazyRuntimeSurface,
} from "../shared/lazy-runtime.js";
export type { LazyPromiseLoader } from "../shared/lazy-runtime.js";

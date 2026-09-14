// Lazy structured-extraction facade that avoids loading model/provider code
// until the generic fallback is invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadStructuredRuntime = createLazyRuntimeModule(() => import("./structured.js"));
const bindStructuredRuntime = createLazyRuntimeMethodBinder(loadStructuredRuntime);

/** Runs the generic model-backed structured extraction fallback. */
export const extractStructuredWithModelFallback = bindStructuredRuntime(
  (runtime) => runtime.extractStructuredWithModelFallbackCore,
);

// Lazy structured-extraction facade that avoids loading model/provider and
// schema-validation code until structured extraction is actually invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadStructuredExtractionRuntime = createLazyRuntimeModule(
  () => import("./structured-extraction.js"),
);
const bindStructuredExtractionRuntime = createLazyRuntimeMethodBinder(
  loadStructuredExtractionRuntime,
);

/** Runs structured extraction through the generic model runtime. */
export const extractStructuredWithImageModel = bindStructuredExtractionRuntime(
  (runtime) => runtime.extractStructuredWithImageModel,
);

// Lazy image-runtime facade that avoids loading model/provider code until image
// understanding or structured extraction is invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadImageRuntime = createLazyRuntimeModule(() => import("./image.js"));
const bindImageRuntime = createLazyRuntimeMethodBinder(loadImageRuntime);
const loadStructuredExtractionRuntime = createLazyRuntimeModule(
  () => import("./structured-extraction.js"),
);
const bindStructuredExtractionRuntime = createLazyRuntimeMethodBinder(
  loadStructuredExtractionRuntime,
);

/** Describes one image through the configured media runtime. */
export const describeImageWithModel = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelCore,
);
/** Describes multiple images through the configured media runtime. */
export const describeImagesWithModel = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelCore,
);
/** Describes one image after applying the runtime payload transform. */
export const describeImageWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelPayloadTransformCore,
);
/** Describes multiple images after applying the runtime payload transform. */
export const describeImagesWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelPayloadTransformCore,
);
/** Extracts structured data from images through the configured media runtime. */
export const extractStructuredWithImageModel = bindStructuredExtractionRuntime(
  (runtime) => runtime.extractStructuredWithImageModelCore,
);
/** Extracts structured data from images after applying the runtime payload transform. */
export const extractStructuredWithImageModelPayloadTransform = bindStructuredExtractionRuntime(
  (runtime) => runtime.extractStructuredWithImageModelPayloadTransformCore,
);

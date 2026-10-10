// Lazy image-runtime facade that avoids loading model/provider code until image
// understanding is invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadImageRuntime = createLazyRuntimeModule(() => import("./image.js"));
const bindImageRuntime = createLazyRuntimeMethodBinder(loadImageRuntime);

export const describeImageWithModel = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelCore,
);
export const describeImagesWithModel = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelCore,
);
export const describeImageWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImageWithModelPayloadTransformCore,
);
export const describeImagesWithModelPayloadTransform = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModelPayloadTransformCore,
);

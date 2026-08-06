// Lazy structured-extraction facade that avoids loading model/provider and
// schema-validation code until structured extraction is actually invoked.
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from "./types.js";

type DescribeImages = (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;

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

/**
 * Structured extraction bound to a specific describeImages executor, so a
 * provider's own request transform is preserved. Stays lazy: the factory is
 * only reached when extraction actually runs.
 */
export function createStructuredExtractionWithImageModel(
  describeImages: DescribeImages,
): (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult> {
  return async (req) => {
    const runtime = await loadStructuredExtractionRuntime();
    return await runtime.createStructuredExtractionWithImageModel(describeImages)(req);
  };
}

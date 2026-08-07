// Lazy structured-extraction facade that avoids loading model/provider and
// schema-validation code until structured extraction is actually invoked.
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
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

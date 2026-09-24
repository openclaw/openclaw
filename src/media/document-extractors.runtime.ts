// Document extractor runtime helpers choose lazy extraction adapters by media type.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";

const extractionIntegerSchema = z.number().int().max(Number.MAX_SAFE_INTEGER);
const extractionMetadataSchema = z.object({
  pages: z
    .object({
      processed: z.array(extractionIntegerSchema.positive()),
      total: extractionIntegerSchema.nonnegative(),
      selection: z.enum(["automatic", "explicit"]),
      truncated: z.boolean(),
    })
    .optional(),
  textTruncated: z.boolean(),
  imagesTruncated: z.boolean(),
});

/** Runs the first matching plugin document extractor and tags successful results with its extractor id. */
export async function extractDocumentContent(
  params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
  },
): Promise<(DocumentExtractionResult & { extractor: string }) | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  params.signal?.throwIfAborted();
  const extractors = resolvePluginDocumentExtractors({ config: params.config });
  params.signal?.throwIfAborted();
  // Keep config and loader-only fields out of plugin calls; extractors receive the SDK request shape.
  const request: DocumentExtractionRequest = {
    buffer: params.buffer,
    mimeType: params.mimeType,
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.password ? { password: params.password } : {}),
    ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onImageExtractionError
      ? { onImageExtractionError: params.onImageExtractionError }
      : {}),
  };
  const errors: unknown[] = [];

  for (const extractor of extractors) {
    if (
      !extractor.mimeTypes.map((entry) => normalizeLowercaseStringOrEmpty(entry)).includes(mimeType)
    ) {
      continue;
    }
    try {
      const result = await extractor.extract(request);
      params.signal?.throwIfAborted();
      if (result) {
        const { metadata, ...content } = result;
        const validatedMetadata = extractionMetadataSchema.safeParse(metadata);
        const parsedMetadata = validatedMetadata.success ? validatedMetadata.data : undefined;
        const pages = parsedMetadata?.pages;
        const requestedPageSet = request.pageNumbers ? new Set(request.pageNumbers) : undefined;
        const hasOmittedPages =
          (pages?.processed.length ?? 0) < (requestedPageSet?.size ?? pages?.total ?? 0);
        // Automatic page choice belongs to the extractor; maxPages only caps its count.
        // Validate bounded completeness facts before rendering them as trusted prompt text.
        const trustedMetadata =
          parsedMetadata &&
          (!pages ||
            (pages.selection === (request.pageNumbers ? "explicit" : "automatic") &&
              pages.processed.length <= request.maxPages &&
              new Set(pages.processed).size === pages.processed.length &&
              pages.processed.every(
                (page) => page <= pages.total && (!requestedPageSet || requestedPageSet.has(page)),
              ) &&
              (pages.truncated === hasOmittedPages ||
                (hasOmittedPages && parsedMetadata.textTruncated))))
            ? parsedMetadata
            : undefined;
        return {
          ...content,
          ...(trustedMetadata ? { metadata: trustedMetadata } : {}),
          extractor: extractor.id,
        };
      }
    } catch (error) {
      params.signal?.throwIfAborted();
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Document extraction failed for ${mimeType || "unknown MIME type"}`, {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
    });
  }
  return null;
}

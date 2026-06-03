import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
  PluginDocumentExtractorEntry,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";

const documentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginDocumentExtractors(config ? { config } : undefined),
);

type ReadableDocumentExtractor = {
  id: string;
  mimeTypes: string[];
  extract: PluginDocumentExtractorEntry["extract"];
  receiver: unknown;
};

function readDocumentExtractor(entry: unknown): ReadableDocumentExtractor | undefined {
  try {
    const extractor = entry as Partial<PluginDocumentExtractorEntry>;
    const id = typeof extractor.id === "string" && extractor.id.trim() ? extractor.id.trim() : "";
    if (!id || !Array.isArray(extractor.mimeTypes) || typeof extractor.extract !== "function") {
      return undefined;
    }
    return {
      id,
      mimeTypes: extractor.mimeTypes.map((mimeType) => normalizeLowercaseStringOrEmpty(mimeType)),
      extract: extractor.extract,
      receiver: entry,
    };
  } catch {
    return undefined;
  }
}

export async function extractDocumentContent(
  params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
  },
): Promise<(DocumentExtractionResult & { extractor: string }) | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  const extractors = await documentExtractorLoader.load(params.config);
  const request: DocumentExtractionRequest = {
    buffer: params.buffer,
    mimeType: params.mimeType,
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.password ? { password: params.password } : {}),
    ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    ...(params.onImageExtractionError
      ? { onImageExtractionError: params.onImageExtractionError }
      : {}),
  };
  const errors: unknown[] = [];

  for (const extractor of extractors) {
    const readableExtractor = readDocumentExtractor(extractor);
    if (!readableExtractor?.mimeTypes.includes(mimeType)) {
      continue;
    }
    try {
      const result = await readableExtractor.extract.call(readableExtractor.receiver, request);
      if (result) {
        return {
          ...result,
          extractor: readableExtractor.id,
        };
      }
    } catch (error) {
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

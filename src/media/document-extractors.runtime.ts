import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

let extractorPromise: Promise<ReturnType<typeof resolvePluginDocumentExtractors>> | undefined;
const extractorPromisesByConfig = new WeakMap<
  OpenClawConfig,
  Promise<ReturnType<typeof resolvePluginDocumentExtractors>>
>();

async function loadDocumentExtractors(config?: OpenClawConfig) {
  if (config) {
    const cached = extractorPromisesByConfig.get(config);
    if (cached) {
      return await cached;
    }
    const promise = Promise.resolve().then(() => resolvePluginDocumentExtractors({ config }));
    extractorPromisesByConfig.set(config, promise);
    void promise.catch(() => {
      extractorPromisesByConfig.delete(config);
    });
    return await promise;
  }
  extractorPromise ??= Promise.resolve(resolvePluginDocumentExtractors());
  return await extractorPromise;
}

export async function extractDocumentContent(
  params: DocumentExtractionRequest & {
    config?: OpenClawConfig;
  },
): Promise<(DocumentExtractionResult & { extractor: string }) | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  let extractors: Awaited<ReturnType<typeof loadDocumentExtractors>>;
  try {
    extractors = await loadDocumentExtractors(params.config);
  } catch {
    return null;
  }

  for (const extractor of extractors) {
    if (
      !extractor.mimeTypes.map((entry) => normalizeLowercaseStringOrEmpty(entry)).includes(mimeType)
    ) {
      continue;
    }
    try {
      const result = await extractor.extract(params);
      if (result) {
        return {
          ...result,
          extractor: extractor.id,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

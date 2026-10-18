import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { extractDocumentContent } from "./document-extractors.runtime.js";

/** Image payload extracted from a PDF page by the document-extract plugin. */
export type PdfExtractedImage = DocumentExtractedImage;
/** Text and extracted image payloads returned by PDF extraction callers. */
export type PdfExtractedContent = DocumentExtractionResult;

/** Extracts PDF content through the configured document extractor. */
export async function extractPdfContent(
  params: Omit<DocumentExtractionRequest, "mimeType"> & { config?: OpenClawConfig },
): Promise<PdfExtractedContent> {
  // The document owner strips config and loader-only fields before plugin dispatch.
  const extracted = await extractDocumentContent({
    ...params,
    mimeType: "application/pdf",
  });
  if (!extracted) {
    throw new Error(
      "PDF extraction disabled or unavailable: enable the document-extract plugin to process application/pdf files.",
    );
  }
  return extracted;
}

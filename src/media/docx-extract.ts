// Docx extraction helpers read .docx text through configured document extraction.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DocumentExtractionResult } from "../plugins/document-extractor-types.js";
import { extractDocumentContent } from "./document-extractors.runtime.js";

/** Wire MIME shared with extractor plugin and DEFAULT_INPUT_FILE_MIMES. */
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Text payload returned by .docx extraction callers. .docx never emits images. */
export type DocxExtractedContent = Pick<DocumentExtractionResult, "text">;

/** Extracts .docx content through the configured document extractor and hides extractor metadata. */
export async function extractDocxContent(params: {
  buffer: Buffer;
  config?: OpenClawConfig;
}): Promise<DocxExtractedContent> {
  const extracted = await extractDocumentContent({
    buffer: params.buffer,
    mimeType: DOCX_MIME_TYPE,
    // PDF-flavored knobs are unused for .docx but the request shape requires
    // them; pass zeros so plugins reading these fields treat them as "skip".
    maxPages: 0,
    maxPixels: 0,
    minTextChars: 0,
    ...(params.config ? { config: params.config } : {}),
  });
  if (!extracted) {
    throw new Error(
      "DOCX extraction disabled or unavailable: enable the document-extract plugin to process .docx files.",
    );
  }
  return { text: extracted.text };
}

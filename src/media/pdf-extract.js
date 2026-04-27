import { extractDocumentContent } from "./document-extractors.runtime.js";
export async function extractPdfContent(params) {
    const extracted = await extractDocumentContent({
        buffer: params.buffer,
        mimeType: "application/pdf",
        maxPages: params.maxPages,
        maxPixels: params.maxPixels,
        minTextChars: params.minTextChars,
        ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
        ...(params.config ? { config: params.config } : {}),
        ...(params.onImageExtractionError
            ? { onImageExtractionError: params.onImageExtractionError }
            : {}),
    });
    if (!extracted) {
        throw new Error("PDF extraction disabled or unavailable: enable the document-extract plugin to process application/pdf files.");
    }
    return {
        text: extracted.text,
        images: extracted.images,
    };
}

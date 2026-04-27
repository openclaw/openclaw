import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DocumentExtractedImage, DocumentExtractionResult } from "../plugins/document-extractor-types.js";
export type PdfExtractedImage = DocumentExtractedImage;
export type PdfExtractedContent = DocumentExtractionResult;
export declare function extractPdfContent(params: {
    buffer: Buffer;
    maxPages: number;
    maxPixels: number;
    minTextChars: number;
    pageNumbers?: number[];
    config?: OpenClawConfig;
    onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent>;

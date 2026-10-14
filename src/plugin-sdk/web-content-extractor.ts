/**
 * Public SDK subpath for web content extractor plugin types and HTML cleanup helpers.
 */
export type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
  WebContentExtractorPlugin,
} from "../plugins/web-content-extractor-types.js";
export { htmlToMarkdown, normalizeWhitespace } from "../agents/tools/web-fetch-utils.js";
export { sanitizeHtml } from "../agents/tools/web-fetch-visibility.js";
export { stripInvisibleUnicode } from "../infra/unicode-visibility.js";

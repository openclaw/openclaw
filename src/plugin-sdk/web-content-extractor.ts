export type {
  WebContentExtractionRequest,
  WebContentExtractionResult,
  WebContentExtractorPlugin,
} from "../plugins/web-content-extractor-types.js";
// Text mode reuses the shared markdown-to-text renderer so block boundaries survive.
export {
  htmlToMarkdown,
  markdownToText,
  normalizeWhitespace,
} from "../agents/tools/web-fetch-utils.js";
export { sanitizeHtml } from "../agents/tools/web-fetch-visibility.js";
export { stripInvisibleUnicode } from "../infra/unicode-visibility.js";

/** Static outbound formatting capabilities declared by a channel plugin. */
export type { FormatCapabilityProfile } from "../../packages/markdown-core/src/format-capabilities.js";

/** Parse Markdown into the shared intermediate representation for native renderers. */
export { markdownToIR } from "../../packages/markdown-core/src/ir.js";

/** Render Markdown into text plus channel-owned attributed ranges. */
export { renderMarkdownWithAttributedRanges } from "../../packages/markdown-core/src/render-attributed.js";

import type { EnvelopeFormatOptions } from "../envelope.js";
import type { TemplateContext } from "../templating.js";
export declare function buildInboundMetaSystemPrompt(ctx: TemplateContext, options?: {
    includeFormattingHints?: boolean;
}): string;
export declare function buildInboundUserContextPrefix(ctx: TemplateContext, envelope?: EnvelopeFormatOptions): string;

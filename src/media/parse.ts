import { findMarkdownImageSpans } from "../../packages/markdown-core/src/image-spans.js";
import { splitMediaOutput } from "./parse-output.js";

/** Controls which non-MEDIA syntaxes may be lifted into media attachments. */
type SplitMediaFromOutputOptions = {
  extractAudioDirectives?: boolean;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
  preserveTrailingWhitespace?: boolean;
  markdownImageAllowlist?: readonly string[];
  /** Observes accepted audio directives after media extraction. */
  onAudioDirective?: () => void;
};

/** Splits tool/stdout text into visible text, media attachments, voice tags, and ordered segments. */
export function splitMediaFromOutput(
  raw: string,
  options: SplitMediaFromOutputOptions = {},
): ReturnType<typeof splitMediaOutput> {
  // The public parser's allowlist opts into image extraction even when the flag is false.
  const extractMarkdownImages =
    options.markdownImageAllowlist !== undefined || options.extractMarkdownImages === true;
  return splitMediaOutput(
    raw,
    options,
    extractMarkdownImages
      ? { scan: findMarkdownImageSpans, allowlist: options.markdownImageAllowlist }
      : undefined,
  );
}

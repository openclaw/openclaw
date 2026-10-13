import { findAssistantTranscriptRoleHeaderSpans } from "../../../packages/markdown-core/src/assistant-transcript-headers.js";
import { applyConstructFallbacks } from "../../../packages/markdown-core/src/construct-fallbacks.js";
import type { FormatCapabilityProfile } from "../../../packages/markdown-core/src/format-capabilities.js";
import {
  applyMarkdownTextEdits,
  type MarkdownTextEdit,
} from "../../../packages/markdown-core/src/ir-spans.js";
import { markdownToIR, type MarkdownIR } from "../../../packages/markdown-core/src/ir.js";
import { stripHtmlFromMarkdown } from "../../../packages/markdown-core/src/strip-html.js";

type StripMarkdownOptions = {
  /** Mark parsed assistant transcript-role headers in transports without rich text. */
  assistantTranscriptRoleHeaders?: boolean;
  /** Prefix inserted before each marked transcript-role header. */
  assistantTranscriptRolePrefix?: string;
  /** Link projection after formatting is removed. Default: label-and-url. */
  linkStyle?: "label" | "label-and-url";
  /** Plain-text cleanup target. Speech removes decorative symbol and punctuation runs. */
  mode?: "plain-text" | "speech";
  /** Omit authored HTML tags and raw-text content while preserving code literals. */
  stripHtml?: boolean;
};

function collectLinkInsertions(ir: MarkdownIR, options: StripMarkdownOptions): MarkdownTextEdit[] {
  const insertions: MarkdownTextEdit[] = [];
  if ((options.linkStyle ?? "label-and-url") === "label-and-url") {
    for (const link of ir.links) {
      const href = link.href.trim();
      const label = ir.text.slice(link.start, link.end).trim();
      const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      if (href && label && label !== href && label !== comparableHref) {
        insertions.push({ start: link.end, end: link.end, text: ` (${href})` });
      }
    }
  }
  return insertions;
}

function collectAssistantTranscriptRoleInsertions(
  source: string | MarkdownIR,
  options: StripMarkdownOptions,
): MarkdownTextEdit[] {
  if (options.assistantTranscriptRoleHeaders !== true) {
    return [];
  }
  const prefix = options.assistantTranscriptRolePrefix ?? "[assistant-authored transcript] ";
  if (!prefix) {
    return [];
  }
  const spans =
    typeof source === "string"
      ? findAssistantTranscriptRoleHeaderSpans(source)
      : (source.annotations ?? []).filter(
          (annotation) => annotation.type === "assistant_transcript_role",
        );
  return spans.map((span) => ({ start: span.start, end: span.start, text: prefix }));
}

function cleanSpeechText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^[\p{P}\p{S}\s]+$/u.test(line)) {
        return "";
      }
      return line
        .replace(/^[•◦▪‣⁃]\s+/u, "")
        .replace(/(?:[\p{So}\p{Sk}]\s*){2,}/gu, " ")
        .replace(/\.{4,}/g, "...")
        .replace(/([!?,;:])\1+/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse Markdown, then protect role headers exposed by the final plain-text projection. */
export function stripMarkdown(
  text: string,
  options: StripMarkdownOptions = {},
  profile?: FormatCapabilityProfile,
): string {
  // The IR parser preserves links when role annotations are enabled so this
  // plain-text projection can still append explicit destinations. Direct rich
  // renderers suppress overlapping active links later at their own boundary.
  const ir = markdownToIR(options.stripHtml ? stripHtmlFromMarkdown(text) : text, {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders,
    autolink: false,
    blockquotePrefix: "",
    enableHtmlUnderline: profile !== undefined,
    enableTaskLists: profile !== undefined,
    headingStyle: "none",
    horizontalRuleText: "",
    linkify: false,
    preserveSourceBlockSpacing: true,
    tableMode: "bullets",
  });
  // Detect against the exact leading boundary transports receive. String.trim
  // removes Unicode whitespace that the transcript header grammar intentionally
  // does not treat as Markdown indentation.
  const effectiveProfile =
    profile && options.linkStyle === "label"
      ? { ...profile, constructs: { ...profile.constructs, linkLabel: "strip" as const } }
      : profile;
  const projectedIr = effectiveProfile ? applyConstructFallbacks(ir, effectiveProfile) : ir;
  const plainText = applyMarkdownTextEdits(projectedIr.text, [
    ...collectLinkInsertions(projectedIr, options),
    ...collectAssistantTranscriptRoleInsertions(projectedIr, options),
  ]).text.trim();
  const projected = applyMarkdownTextEdits(
    plainText,
    collectAssistantTranscriptRoleInsertions(plainText, options),
  ).text.trim();
  return options.mode === "speech" ? cleanSpeechText(projected) : projected;
}

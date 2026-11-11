import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { truncateText } from "../lib/format.ts";
import { markdownContentHtml, type MarkdownContent } from "../lib/markdown-content.ts";
import { markdownHighlightingPending } from "./markdown-code-blocks.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  normalizeMarkdownRenderOptions,
  type MarkdownRenderOptions,
} from "./markdown-render-options.ts";
import { streamingMarkdownState } from "./markdown-streaming-state.ts";
import {
  hasStreamingMarkdownHtml,
  repairStreamingMarkdownTail,
  splitStableStreamingMarkdown,
} from "./markdown-streaming.ts";
import { isMarkdownBlockArtText, normalizeMarkdownLineBreaks } from "./markdown-text.ts";
import { renderMarkdownTokens } from "./markdown-tokens.ts";
import {
  appendMarkdownTruncationNotice,
  HIGHLIGHTABLE_CODE_RE,
  MARKDOWN_CHAR_LIMIT,
  markdownRenderKey,
  partitionMarkdownHtml,
  renderSanitizedMarkdown,
  toSanitizedMarkdownHtml,
} from "./markdown.ts";

function normalizeStreamingMarkdownInput(markdownLocal: string, streamKey?: string): string {
  const source = stripUnsupportedCitationControlMarkers(markdownLocal);
  const state = streamingMarkdownState(streamKey);
  const cached = state?.input;
  let normalized: string;
  if (cached && source.startsWith(cached.source)) {
    const appended = source.slice(cached.source.length);
    const normalizedAppend = normalizeMarkdownLineBreaks(appended);
    normalized =
      cached.source.endsWith("\r") && appended.startsWith("\n")
        ? `${cached.normalized.slice(0, -1)}${normalizedAppend}`
        : `${cached.normalized}${normalizedAppend}`;
  } else {
    normalized = normalizeMarkdownLineBreaks(source);
  }
  if (state) {
    state.input = source.length <= MARKDOWN_CHAR_LIMIT ? { source, normalized } : undefined;
  }
  return normalized;
}

export function toStreamingMarkdownDomParts(
  markdownLocal: string,
  options: MarkdownRenderOptions = {},
  streamKey?: string,
): [MarkdownContent, MarkdownContent] {
  const renderOptions = normalizeMarkdownRenderOptions(options);
  // Explicit selections are complete user input, not incremental assistant text.
  if (renderOptions.humanMentions.length) {
    return partitionMarkdownHtml(toSanitizedMarkdownHtml(markdownLocal, options), streamKey);
  }
  const rawInput = normalizeStreamingMarkdownInput(markdownLocal, streamKey);
  if (isMarkdownBlockArtText(rawInput)) {
    return ["", renderSanitizedMarkdown(rawInput, renderOptions)];
  }

  if (!rawInput.trim()) {
    return ["", ""];
  }
  const truncated = truncateText(rawInput, MARKDOWN_CHAR_LIMIT);
  const input = appendMarkdownTruncationNotice(truncated);

  const { boundary: candidateBoundary, tailRepairStart } = splitStableStreamingMarkdown(
    input,
    streamKey,
    truncated.text.length,
  );
  let boundary = candidateBoundary;
  const stableMarkdown = input.slice(0, boundary);
  let streamingTail = input.slice(boundary);
  const state = streamingMarkdownState(streamKey);
  const previous = state?.rendered;
  const renderKey = markdownRenderKey(renderOptions);
  const append = previous && stableMarkdown.startsWith(previous.markdown);
  // Literal code cannot acquire HTML ownership after its block is complete.
  const hasHtml = append
    ? previous.hasHtml || hasStreamingMarkdownHtml(stableMarkdown.slice(previous.markdown.length))
    : hasStreamingMarkdownHtml(stableMarkdown);
  // Containers and block-art classification can outlive a completed boundary.
  // The message parse guard also keeps applying to the complete prefix.
  const incremental =
    previous?.options === renderKey &&
    append &&
    (previous.markdown === stableMarkdown ||
      (previous.markdown.endsWith("\n") &&
        !/^(?: {4}| {0,3}[\t>])/mu.test(stableMarkdown) &&
        !/^ {0,3}(?:[-+*]|\d{1,9}[.)])$/mu.test(stableMarkdown) &&
        !hasHtml &&
        !isMarkdownBlockArtText(stableMarkdown) &&
        !previous.html.includes('class="markdown-block-art"') &&
        (renderOptions.mode === "document" || boundary <= MARKDOWN_PARSE_LIMIT)));
  let stableHtml = incremental ? previous.html : "";
  const stableAppend = stableMarkdown.slice(incremental ? previous.markdown.length : 0);
  if (stableAppend) {
    const appendedHtml = markdownContentHtml(
      renderSanitizedMarkdown(stableAppend, { ...renderOptions }),
    );
    // File-label collisions and standalone block art depend on the whole prefix.
    stableHtml =
      (stableHtml.length > 0 && isMarkdownBlockArtText(stableAppend)) ||
      (renderOptions.fileLinks &&
        stableHtml.includes('class="markdown-file-link"') &&
        appendedHtml.includes('class="markdown-file-link"'))
        ? markdownContentHtml(renderSanitizedMarkdown(stableMarkdown, { ...renderOptions }))
        : stableHtml + appendedHtml;
  }
  if (HIGHLIGHTABLE_CODE_RE.test(stableHtml) && markdownHighlightingPending()) {
    // Keep provisional code in the mutable tail so highlighting can arrive
    // before its DOM is promoted to stable content, preserving reader controls.
    const retained = previous?.options === renderKey && append ? previous : undefined;
    boundary = retained?.markdown.length ?? 0;
    stableHtml = retained?.html ?? "";
    streamingTail = input.slice(boundary);
  } else if (state) {
    state.rendered = { options: renderKey, markdown: stableMarkdown, html: stableHtml, hasHtml };
  }
  if (!streamingTail.trim()) {
    return [stableHtml, ""];
  }
  // Only the live tail uses direct construction; settled messages and the
  // completed prefix retain the bulk HTML + DOMPurify path.
  // The whole input was classified above; an isolated tail is not block art.
  const tailHtml = renderSanitizedMarkdown(
    tailRepairStart === null
      ? streamingTail
      : repairStreamingMarkdownTail(streamingTail, tailRepairStart - boundary),
    tailRepairStart === null ? { ...renderOptions, streamingOpenFence: true } : renderOptions,
    false,
    renderMarkdownTokens,
  );
  return [stableHtml, tailHtml];
}

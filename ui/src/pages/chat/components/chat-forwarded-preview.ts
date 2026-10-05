import { t } from "../../../i18n/index.ts";
import { takeGraphemes } from "../../../lib/graphemes.ts";

const PREVIEW_CHAR_LIMIT = 280;
const FIRST_SENTENCE_CHAR_LIMIT = 420;
const PREVIEW_LINE_LIMIT = 3;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Excerpt sanitized render output, never Markdown source or the reader's live DOM. */
export function createForwardedMessagePreview(
  sanitizedHtml: string,
  mediaPrefix?: string,
): string | null {
  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;
  let omittedContent = false;
  // Images have no text budget. Use their label in the excerpt; Show more owns
  // the complete image/attachment rather than cropping a media card in half.
  for (const image of template.content.querySelectorAll("img:not(.markdown-link-favicon)")) {
    const label = document.createTextNode(image.getAttribute("alt") || t("chat.attachments.image"));
    (image.closest("button") ?? image).replaceWith(label);
    omittedContent = true;
  }
  // A code excerpt is read-only. Keep the original controls, JSON tree and copy
  // payload together in the full message instead of copying misleading controls.
  for (const wrapper of template.content.querySelectorAll(".code-block-wrapper")) {
    const pre = wrapper.querySelector("pre");
    if (pre) {
      wrapper.replaceWith(pre);
    }
  }
  for (const pre of template.content.querySelectorAll("pre")) {
    const code = pre.querySelector("code") ?? pre;
    const rows = (code.textContent ?? "").replace(/\n$/u, "").split("\n");
    if (rows.length > PREVIEW_LINE_LIMIT) {
      code.textContent = rows.slice(0, PREVIEW_LINE_LIMIT).join("\n");
      omittedContent = true;
    }
  }
  for (const control of template.content.querySelectorAll("button, svg, [aria-hidden='true']")) {
    control.remove();
  }

  // Empty rules, fences and authored disclosures still occupy vertical space.
  // Bound whole structural blocks before applying the visible-text budget.
  const overflowBlock = template.content.querySelectorAll(
    "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr, br, summary, hr, details",
  )[PREVIEW_LINE_LIMIT];
  if (overflowBlock) {
    const remainder = document.createRange();
    remainder.setStartBefore(overflowBlock);
    remainder.setEnd(template.content, template.content.childNodes.length);
    remainder.deleteContents();
    omittedContent = true;
  }

  const spans: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  const separator = () => {
    if (text && !text.endsWith("\n")) {
      text += "\n";
    }
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      if (mediaPrefix && node.data.includes(mediaPrefix)) {
        node.data = node.data.replace(new RegExp(`${mediaPrefix}\\d+END`, "gu"), () => {
          omittedContent = true;
          return t("chat.attachments.attachedFile");
        });
      }
      spans.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
      return;
    }
    const block =
      node instanceof Element && /^(P|LI|PRE|BLOCKQUOTE|H[1-6]|TR|BR|SUMMARY)$/.test(node.tagName);
    if (block) {
      separator();
    }
    for (const child of node.childNodes) {
      visit(child);
    }
    if (block) {
      separator();
    }
  };
  visit(template.content);
  text = text.trimEnd();
  const lines = [...text.matchAll(/[^\n]+/gu)];
  const lineEnd = lines[PREVIEW_LINE_LIMIT - 1];
  const limit = Math.min(
    PREVIEW_CHAR_LIMIT,
    lineEnd ? lineEnd.index + lineEnd[0].length : text.length,
  );
  if (text.length <= limit) {
    return omittedContent ? template.innerHTML : null;
  }

  let end = 0;
  for (const { index, segment } of sentenceSegmenter.segment(text)) {
    const boundary = index + segment.trimEnd().length;
    if (boundary > limit) {
      if (
        !end &&
        boundary <= FIRST_SENTENCE_CHAR_LIMIT &&
        (!lineEnd || boundary <= lineEnd.index + lineEnd[0].length)
      ) {
        end = boundary;
      }
      break;
    }
    end = boundary;
  }
  // A long sentence, code line, or punctuation-free note still needs a compact
  // excerpt. Prefer complete words; graphemes bound an unbroken URL or token.
  const sentenceEnd = end > 0;
  if (!end) {
    for (const { index, segment } of wordSegmenter.segment(text)) {
      if (index + segment.length > limit) {
        break;
      }
      end = index + segment.length;
    }
    if (end < limit / 2) {
      end = takeGraphemes(text, PREVIEW_CHAR_LIMIT).length;
    }
  }
  end = text.slice(0, end).trimEnd().length;
  if (end >= text.length) {
    return omittedContent ? template.innerHTML : null;
  }
  const last = spans.find((span) => span.start < end && span.end >= end);
  if (!last) {
    return null;
  }
  const range = document.createRange();
  range.setStart(template.content, 0);
  range.setEnd(last.node, end - last.start);
  const preview = document.createElement("div");
  preview.append(range.cloneContents());
  if (!sentenceEnd) {
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let terminal: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      terminal = node;
    }
    // Keep omission punctuation outside links but inside their paragraph/list.
    const anchor = terminal?.parentElement?.closest("a");
    const target = anchor ?? terminal;
    if (target) {
      target.parentNode?.insertBefore(document.createTextNode("…"), target.nextSibling);
    }
  }
  return preview.innerHTML;
}

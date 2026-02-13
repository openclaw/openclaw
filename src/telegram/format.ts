import type { MarkdownTableMode } from "../config/types.base.js";
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
} from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * File extensions that share TLDs and commonly appear in code/documentation.
 * These are wrapped in <code> tags to prevent Telegram from generating
 * spurious domain registrar previews.
 *
 * Only includes extensions that are:
 * 1. Commonly used as file extensions in code/docs
 * 2. Rarely used as intentional domain references
 *
 * Excluded: .ai, .io, .tv, .fm (popular domain TLDs like x.ai, vercel.io, github.io)
 */
const FILE_EXTENSIONS_WITH_TLD = new Set([
  "md", // Markdown (Moldova) - very common in repos
  "go", // Go language - common in Go projects
  "py", // Python (Paraguay) - common in Python projects
  "pl", // Perl (Poland) - common in Perl projects
  "sh", // Shell (Saint Helena) - common for scripts
  "am", // Automake files (Armenia)
  "at", // Assembly (Austria)
  "be", // Backend files (Belgium)
  "cc", // C++ source (Cocos Islands)
]);

/** Detects when markdown-it linkify auto-generated a link from a bare filename (e.g. README.md → http://README.md) */
function isAutoLinkedFileRef(href: string, label: string): boolean {
  const stripped = href.replace(/^https?:\/\//i, "");
  if (stripped !== label) {
    return false;
  }
  const dotIndex = label.lastIndexOf(".");
  if (dotIndex < 1) {
    return false;
  }
  const ext = label.slice(dotIndex + 1).toLowerCase();
  if (!FILE_EXTENSIONS_WITH_TLD.has(ext)) {
    return false;
  }
  // Reject if any path segment before the filename contains a dot (looks like a domain)
  const segments = label.split("/");
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i].includes(".")) {
        return false;
      }
    }
  }
  return true;
}

function buildTelegramLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  if (link.start === link.end) {
    return null;
  }
  // Suppress auto-linkified file references (e.g. README.md → http://README.md)
  const label = text.slice(link.start, link.end);
  if (isAutoLinkedFileRef(href, label)) {
    return null;
  }
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; wrapFileRefs?: boolean } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const html = renderTelegramHtml(ir);
  // Apply file reference wrapping if requested (for chunked rendering)
  if (options.wrapFileRefs !== false) {
    return wrapFileReferencesInHtml(html);
  }
  return html;
}

/**
 * Wraps standalone file references (with TLD extensions) in <code> tags.
 * This prevents Telegram from treating them as URLs and generating
 * irrelevant domain registrar previews.
 *
 * Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
 * Skips content inside <code>, <pre>, and <a> tags to avoid nesting issues.
 */
/** Escape regex metacharacters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wrapFileReferencesInHtml(html: string): string {
  // Build regex pattern for all tracked extensions (escape metacharacters for safety)
  const extensionsPattern = Array.from(FILE_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");

  // Safety-net: de-linkify auto-generated anchors where href="http://<label>" (defense in depth for textMode: "html")
  const autoLinkedAnchor = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
  html = html.replace(autoLinkedAnchor, (_match, label: string) => {
    if (!isAutoLinkedFileRef(`http://${label}`, label)) {
      return _match;
    }
    return `<code>${escapeHtml(label)}</code>`;
  });
  const filePattern = new RegExp(
    `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${extensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
    "gi",
  );

  // Track nesting depth for tags that should not be modified
  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;
  let result = "";
  let lastIndex = 0;

  // Process the HTML token by token to respect tag boundaries
  const tagPattern = /(<\/?)(code|pre|a)\b[^>]*?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = tagPattern.lastIndex;
    const isClosing = match[1] === "</";
    const tagName = match[2].toLowerCase();

    // Process text before this tag
    const textBefore = html.slice(lastIndex, tagStart);
    result += textBefore.replace(filePattern, (m, prefix, filename, offset, source) => {
      // Skip if inside protected tags or if it's a URL
      if (codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
        return m;
      }
      // Skip if we're inside any HTML tag (e.g., attributes on tags other than code/pre/a)
      const filenameOffset = Number(offset) + String(prefix).length;
      const lastOpen = String(source).lastIndexOf("<", filenameOffset);
      const lastClose = String(source).lastIndexOf(">", filenameOffset);
      if (lastOpen > lastClose) {
        return m;
      }
      if (filename.startsWith("//")) {
        return m;
      }
      if (/https?:\/\/$/i.test(prefix)) {
        return m;
      }
      return `${prefix}<code>${escapeHtml(filename)}</code>`;
    });

    // Update tag depth (clamp at 0 for malformed HTML with stray closing tags)
    if (tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (tagName === "pre") {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    } else if (tagName === "a") {
      anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
    }

    // Add the tag itself
    result += html.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  // Process remaining text
  const remainingText = html.slice(lastIndex);
  result += remainingText.replace(filePattern, (m, prefix, filename, offset, source) => {
    if (codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
      return m;
    }
    const filenameOffset = Number(offset) + String(prefix).length;
    const lastOpen = String(source).lastIndexOf("<", filenameOffset);
    const lastClose = String(source).lastIndexOf(">", filenameOffset);
    if (lastOpen > lastClose) {
      return m;
    }
    if (filename.startsWith("//")) {
      return m;
    }
    if (/https?:\/\/$/i.test(prefix)) {
      return m;
    }
    return `${prefix}<code>${escapeHtml(filename)}</code>`;
  });

  // Second pass: catch orphaned single-letter TLD patterns (e.g., 'D.md' in 'R&D.md')
  // These can be auto-linked by Telegram as domains
  const orphanedTldPattern = new RegExp(
    `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${extensionsPattern}))(?=[^a-zA-Z0-9/]|$)`,
    "g",
  );
  // Snapshot for offset calculations (offset is relative to pre-replacement string)
  // Note: replace() doesn't mutate, but snapshot makes intent explicit
  const snapshot = result;
  result = snapshot.replace(orphanedTldPattern, (m, prefix, tld, offset) => {
    // Skip if prefix is > (right after a tag close)
    if (prefix === ">") {
      return m;
    }
    // Skip if we're inside an HTML tag (between < and >)
    const lastOpen = snapshot.lastIndexOf("<", offset);
    const lastClose = snapshot.lastIndexOf(">", offset);
    if (lastOpen > lastClose) {
      return m; // Inside a tag attribute
    }
    // Skip if inside code/pre/anchor tags (count opens vs closes before offset)
    const textBefore = snapshot.slice(0, offset);
    const codeOpens = (textBefore.match(/<code/gi) || []).length;
    const codeCloses = (textBefore.match(/<\/code/gi) || []).length;
    const preOpens = (textBefore.match(/<pre/gi) || []).length;
    const preCloses = (textBefore.match(/<\/pre/gi) || []).length;
    const anchorOpens = (textBefore.match(/<a[\s>]/gi) || []).length;
    const anchorCloses = (textBefore.match(/<\/a/gi) || []).length;
    if (codeOpens > codeCloses || preOpens > preCloses || anchorOpens > anchorCloses) {
      return m; // Inside code/pre/anchor content
    }
    return `${prefix}<code>${escapeHtml(tld)}</code>`;
  });

  return result;
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") {
    // For HTML mode, trust caller markup - don't modify
    return text;
  }
  // markdownToTelegramHtml already wraps file references by default
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramFormattedChunk[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => ({
    html: wrapFileReferencesInHtml(renderTelegramHtml(chunk)),
    text: chunk.text,
  }));
}

export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}

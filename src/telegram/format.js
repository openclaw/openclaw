import { chunkMarkdownIR, markdownToIR, } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlAttr(text) {
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
function isAutoLinkedFileRef(href, label) {
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
function buildTelegramLink(link, text) {
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
function renderTelegramHtml(ir) {
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
export function markdownToTelegramHtml(markdown, options = {}) {
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
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const FILE_EXTENSIONS_PATTERN = Array.from(FILE_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const FILE_REFERENCE_PATTERN = new RegExp(`(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=$|[^a-zA-Z0-9_\\-/])`, "gi");
const ORPHANED_TLD_PATTERN = new RegExp(`([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[^a-zA-Z0-9/]|$)`, "g");
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
function wrapStandaloneFileRef(match, prefix, filename) {
    if (filename.startsWith("//")) {
        return match;
    }
    if (/https?:\/\/$/i.test(prefix)) {
        return match;
    }
    return `${prefix}<code>${escapeHtml(filename)}</code>`;
}
function wrapSegmentFileRefs(text, codeDepth, preDepth, anchorDepth) {
    if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
        return text;
    }
    const wrappedStandalone = text.replace(FILE_REFERENCE_PATTERN, wrapStandaloneFileRef);
    return wrappedStandalone.replace(ORPHANED_TLD_PATTERN, (match, prefix, tld) => prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`);
}
export function wrapFileReferencesInHtml(html) {
    // Safety-net: de-linkify auto-generated anchors where href="http://<label>" (defense in depth for textMode: "html")
    AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
    const deLinkified = html.replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label) => {
        if (!isAutoLinkedFileRef(`http://${label}`, label)) {
            return _match;
        }
        return `<code>${escapeHtml(label)}</code>`;
    });
    // Track nesting depth for tags that should not be modified
    let codeDepth = 0;
    let preDepth = 0;
    let anchorDepth = 0;
    let result = "";
    let lastIndex = 0;
    // Process tags token-by-token so we can skip protected regions while wrapping plain text.
    HTML_TAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
        const tagStart = match.index;
        const tagEnd = HTML_TAG_PATTERN.lastIndex;
        const isClosing = match[1] === "</";
        const tagName = match[2].toLowerCase();
        // Process text before this tag
        const textBefore = deLinkified.slice(lastIndex, tagStart);
        result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);
        // Update tag depth (clamp at 0 for malformed HTML with stray closing tags)
        if (tagName === "code") {
            codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
        }
        else if (tagName === "pre") {
            preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
        }
        else if (tagName === "a") {
            anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
        }
        // Add the tag itself
        result += deLinkified.slice(tagStart, tagEnd);
        lastIndex = tagEnd;
    }
    // Process remaining text
    const remainingText = deLinkified.slice(lastIndex);
    result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);
    return result;
}
export function renderTelegramHtmlText(text, options = {}) {
    const textMode = options.textMode ?? "markdown";
    if (textMode === "html") {
        // For HTML mode, trust caller markup - don't modify
        return text;
    }
    // markdownToTelegramHtml already wraps file references by default
    return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}
function splitTelegramChunkByHtmlLimit(chunk, htmlLimit, renderedHtmlLength) {
    const currentTextLength = chunk.text.length;
    if (currentTextLength <= 1) {
        return [chunk];
    }
    const proportionalLimit = Math.floor((currentTextLength * htmlLimit) / Math.max(renderedHtmlLength, 1));
    const candidateLimit = Math.min(currentTextLength - 1, proportionalLimit);
    const splitLimit = Number.isFinite(candidateLimit) && candidateLimit > 0
        ? candidateLimit
        : Math.max(1, Math.floor(currentTextLength / 2));
    const split = splitMarkdownIRPreserveWhitespace(chunk, splitLimit);
    if (split.length > 1) {
        return split;
    }
    return splitMarkdownIRPreserveWhitespace(chunk, Math.max(1, Math.floor(currentTextLength / 2)));
}
function sliceStyleSpans(styles, start, end) {
    return styles.flatMap((span) => {
        if (span.end <= start || span.start >= end) {
            return [];
        }
        const nextStart = Math.max(span.start, start) - start;
        const nextEnd = Math.min(span.end, end) - start;
        if (nextEnd <= nextStart) {
            return [];
        }
        return [{ ...span, start: nextStart, end: nextEnd }];
    });
}
function sliceLinkSpans(links, start, end) {
    return links.flatMap((link) => {
        if (link.end <= start || link.start >= end) {
            return [];
        }
        const nextStart = Math.max(link.start, start) - start;
        const nextEnd = Math.min(link.end, end) - start;
        if (nextEnd <= nextStart) {
            return [];
        }
        return [{ ...link, start: nextStart, end: nextEnd }];
    });
}
function splitMarkdownIRPreserveWhitespace(ir, limit) {
    if (!ir.text) {
        return [];
    }
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (normalizedLimit <= 0 || ir.text.length <= normalizedLimit) {
        return [ir];
    }
    const chunks = [];
    let cursor = 0;
    while (cursor < ir.text.length) {
        const end = Math.min(ir.text.length, cursor + normalizedLimit);
        chunks.push({
            text: ir.text.slice(cursor, end),
            styles: sliceStyleSpans(ir.styles, cursor, end),
            links: sliceLinkSpans(ir.links, cursor, end),
        });
        cursor = end;
    }
    return chunks;
}
function renderTelegramChunksWithinHtmlLimit(ir, limit) {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const pending = chunkMarkdownIR(ir, normalizedLimit);
    const rendered = [];
    while (pending.length > 0) {
        const chunk = pending.shift();
        if (!chunk) {
            continue;
        }
        const html = wrapFileReferencesInHtml(renderTelegramHtml(chunk));
        if (html.length <= normalizedLimit || chunk.text.length <= 1) {
            rendered.push({ html, text: chunk.text });
            continue;
        }
        const split = splitTelegramChunkByHtmlLimit(chunk, normalizedLimit, html.length);
        if (split.length <= 1) {
            // Worst-case safety: avoid retry loops, deliver the chunk as-is.
            rendered.push({ html, text: chunk.text });
            continue;
        }
        pending.unshift(...split);
    }
    return rendered;
}
export function markdownToTelegramChunks(markdown, limit, options = {}) {
    const ir = markdownToIR(markdown ?? "", {
        linkify: true,
        enableSpoilers: true,
        headingStyle: "none",
        blockquotePrefix: "",
        tableMode: options.tableMode,
    });
    return renderTelegramChunksWithinHtmlLimit(ir, limit);
}
export function markdownToTelegramHtmlChunks(markdown, limit) {
    return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}

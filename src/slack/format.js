import { chunkMarkdownIR, markdownToIR } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
function escapeSlackMrkdwnSegment(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;
function isAllowedSlackAngleToken(token) {
    if (!token.startsWith("<") || !token.endsWith(">")) {
        return false;
    }
    const inner = token.slice(1, -1);
    return (inner.startsWith("@") ||
        inner.startsWith("#") ||
        inner.startsWith("!") ||
        inner.startsWith("mailto:") ||
        inner.startsWith("tel:") ||
        inner.startsWith("http://") ||
        inner.startsWith("https://") ||
        inner.startsWith("slack://"));
}
function escapeSlackMrkdwnContent(text) {
    if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
        return text;
    }
    SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
    const out = [];
    let lastIndex = 0;
    for (let match = SLACK_ANGLE_TOKEN_RE.exec(text); match; match = SLACK_ANGLE_TOKEN_RE.exec(text)) {
        const matchIndex = match.index ?? 0;
        out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
        const token = match[0] ?? "";
        out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
        lastIndex = matchIndex + token.length;
    }
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
    return out.join("");
}
function escapeSlackMrkdwnText(text) {
    if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
        return text;
    }
    return text
        .split("\n")
        .map((line) => {
        if (line.startsWith("> ")) {
            return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
        }
        return escapeSlackMrkdwnContent(line);
    })
        .join("\n");
}
function buildSlackLink(link, text) {
    const href = link.href.trim();
    if (!href) {
        return null;
    }
    const label = text.slice(link.start, link.end);
    const trimmedLabel = label.trim();
    const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
    const useMarkup = trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
    if (!useMarkup) {
        return null;
    }
    const safeHref = escapeSlackMrkdwnSegment(href);
    return {
        start: link.start,
        end: link.end,
        open: `<${safeHref}|`,
        close: ">",
    };
}
function buildSlackRenderOptions() {
    return {
        styleMarkers: {
            bold: { open: "*", close: "*" },
            italic: { open: "_", close: "_" },
            strikethrough: { open: "~", close: "~" },
            code: { open: "`", close: "`" },
            code_block: { open: "```\n", close: "```" },
        },
        escapeText: escapeSlackMrkdwnText,
        buildLink: buildSlackLink,
    };
}
export function markdownToSlackMrkdwn(markdown, options = {}) {
    const ir = markdownToIR(markdown ?? "", {
        linkify: false,
        autolink: false,
        headingStyle: "bold",
        blockquotePrefix: "> ",
        tableMode: options.tableMode,
    });
    return renderMarkdownWithMarkers(ir, buildSlackRenderOptions());
}
export function markdownToSlackMrkdwnChunks(markdown, limit, options = {}) {
    const ir = markdownToIR(markdown ?? "", {
        linkify: false,
        autolink: false,
        headingStyle: "bold",
        blockquotePrefix: "> ",
        tableMode: options.tableMode,
    });
    const chunks = chunkMarkdownIR(ir, limit);
    const renderOptions = buildSlackRenderOptions();
    return chunks.map((chunk) => renderMarkdownWithMarkers(chunk, renderOptions));
}

export const HTML_PREVIEW_SANDBOX = "";
export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'";

const MAX_HTML_PREVIEW_CHARS = 750_000;

export type HtmlDocumentPreview = {
  html: string;
  truncated: boolean;
};

export function detectHtmlDocumentPreview(markdown: string): HtmlDocumentPreview | null {
  const candidate = stripMarkdownHtmlFence(markdown);
  if (!looksLikeCompleteHtmlDocument(candidate)) {
    return null;
  }
  if (candidate.length <= MAX_HTML_PREVIEW_CHARS) {
    return { html: candidate, truncated: false };
  }
  return {
    html: `${candidate.slice(
      0,
      MAX_HTML_PREVIEW_CHARS,
    )}\n<!-- OpenClaw: HTML preview truncated at ${MAX_HTML_PREVIEW_CHARS} characters. -->`,
    truncated: true,
  };
}

export function buildHtmlPreviewSrcdoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
    HTML_PREVIEW_CSP,
  )}">`;
  const htmlOpen = findHtmlStartTag(html, "html");
  if (htmlOpen) {
    const firstTagAfterHtml = findFirstHtmlStartTag(html, htmlOpen.end);
    if (firstTagAfterHtml?.tagName === "head") {
      return `${html.slice(0, firstTagAfterHtml.end)}${meta}${html.slice(firstTagAfterHtml.end)}`;
    }
    return `${html.slice(0, htmlOpen.end)}<head>${meta}</head>${html.slice(htmlOpen.end)}`;
  }

  const firstTag = findFirstHtmlStartTag(html);
  if (firstTag?.tagName === "head") {
    return `${html.slice(0, firstTag.end)}${meta}${html.slice(firstTag.end)}`;
  }

  return `${meta}${html}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function findFirstHtmlStartTag(
  html: string,
  startIndex = 0,
  endIndex = html.length,
): { tagName: string; index: number; end: number } | null {
  let index = Math.max(0, startIndex);
  const searchEnd = Math.min(Math.max(index, endIndex), html.length);

  while (index < searchEnd) {
    const open = html.indexOf("<", index);
    if (open === -1 || open >= searchEnd) {
      return null;
    }
    if (html.startsWith("<!--", open)) {
      const commentEnd = html.indexOf("-->", open + 4);
      index = commentEnd === -1 ? searchEnd : commentEnd + 3;
      continue;
    }

    const close = html.indexOf(">", open + 1);
    if (close === -1 || close >= searchEnd) {
      return null;
    }

    const tagText = html.slice(open + 1, close).trimStart();
    const nameMatch = /^([a-z][^\s/>]*)/i.exec(tagText);
    if (nameMatch?.[1] && !tagText.startsWith("/")) {
      return { tagName: nameMatch[1].toLowerCase(), index: open, end: close + 1 };
    }
    index = close + 1;
  }

  return null;
}

function findHtmlStartTag(
  html: string,
  tagName: "body" | "head" | "html",
  startIndex = 0,
  endIndex = html.length,
): { index: number; end: number } | null {
  const normalizedTagName = tagName.toLowerCase();
  let index = Math.max(0, startIndex);
  const searchEnd = Math.min(Math.max(index, endIndex), html.length);

  while (index < searchEnd) {
    const tag = findFirstHtmlStartTag(html, index, searchEnd);
    if (!tag) {
      return null;
    }
    if (tag.tagName === normalizedTagName) {
      return { index: tag.index, end: tag.end };
    }
    index = tag.end;
  }

  return null;
}

function stripMarkdownHtmlFence(markdown: string): string {
  const trimmed = markdown.trim();
  const lineBreak = "(?:\\r\\n|\\n|\\r)";
  const match = new RegExp(
    `^\\\`\\\`\\\`(?:html|htm)[^\\S\\r\\n]*${lineBreak}([\\s\\S]*?)${lineBreak}\\\`\\\`\\\`$`,
    "i",
  ).exec(trimmed);
  return match?.[1] ?? trimmed;
}

function looksLikeCompleteHtmlDocument(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }

  const documentShape =
    "(?:<html(?:\\s[^>]*)?>[\\s\\S]*<\\/html>|<head(?:\\s[^>]*)?>[\\s\\S]*<\\/head>\\s*<body(?:\\s[^>]*)?>[\\s\\S]*<\\/body>)";
  return new RegExp(`^(?:<!doctype\\s+html\\s*>\\s*)?${documentShape}$`, "i").test(trimmed);
}

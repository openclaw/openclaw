/**
 * Visibility filtering for web_fetch content extraction.
 *
 * Strips human-invisible content from HTML to prevent indirect prompt injection:
 * - CSS-hidden elements (display:none, visibility:hidden, opacity:0, etc.)
 * - HTML comments
 * - Invisible Unicode characters
 *
 * Reference: https://github.com/steipete/summarize/issues/61
 */

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

type StyleMap = Record<string, string>;

function parseStyle(style: string): StyleMap {
  const map: StyleMap = {};
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (!key) {
      continue;
    }
    map[key] = value;
  }
  return map;
}

function parseCssNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^(-?\d*\.?\d+)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isHiddenByStyle(style: string): boolean {
  const normalized = style.toLowerCase();

  // Direct visibility checks
  if (/display\s*:\s*none/.test(normalized)) {
    return true;
  }
  if (/visibility\s*:\s*hidden/.test(normalized)) {
    return true;
  }
  if (/opacity\s*:\s*0(?:\.0+)?(?:\s|;|$)/.test(normalized)) {
    return true;
  }
  if (/font-size\s*:\s*0(?:\.0+)?(?:[a-z%]+)?/.test(normalized)) {
    return true;
  }
  if (/clip-path\s*:\s*inset\(\s*100%/i.test(normalized)) {
    return true;
  }
  if (
    /clip\s*:\s*rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/transform\s*:\s*scale\(\s*0(?:\s*,\s*0)?\s*\)/i.test(normalized)) {
    return true;
  }

  const styles = parseStyle(normalized);

  // Zero dimensions with overflow hidden
  const width = parseCssNumber(styles.width);
  const height = parseCssNumber(styles.height);
  const overflow = styles.overflow ?? "";
  if (width === 0 && height === 0 && overflow.startsWith("hidden")) {
    return true;
  }

  // Negative text-indent
  const textIndent = parseCssNumber(styles["text-indent"]);
  if (textIndent !== null && textIndent <= -999) {
    return true;
  }

  // Offscreen positioning
  const position = styles.position;
  if (position === "absolute" || position === "fixed") {
    const left = parseCssNumber(styles.left);
    const top = parseCssNumber(styles.top);
    if (left !== null && left <= -999) {
      return true;
    }
    if (top !== null && top <= -999) {
      return true;
    }
  }

  return false;
}

const HIDDEN_TAGS = new Set([
  "template",
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
]);

function shouldStripElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();

  // Always strip these tags
  if (HIDDEN_TAGS.has(tagName)) {
    return true;
  }

  // HTML hidden attribute
  if (element.hasAttribute("hidden")) {
    return true;
  }

  // ARIA hidden
  const ariaHidden = element.getAttribute("aria-hidden");
  if (ariaHidden === "true" || ariaHidden === "1") {
    return true;
  }

  // Hidden input
  if (tagName === "input" && element.getAttribute("type") === "hidden") {
    return true;
  }

  // CSS-based hiding
  const style = element.getAttribute("style");
  if (style && isHiddenByStyle(style)) {
    return true;
  }

  return false;
}

/**
 * Strip CSS-hidden elements and HTML comments from HTML content.
 * Uses linkedom for DOM parsing (already a project dependency).
 */
export async function stripHiddenHtml(html: string): Promise<string> {
  if (!html) {
    return html;
  }

  // Remove HTML comments first
  const withoutComments = html.replace(COMMENT_PATTERN, "");

  try {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(withoutComments);

    // Collect elements to remove (can't modify while iterating)
    const toRemove: Element[] = [];
    const allElements = document.querySelectorAll("*");
    for (const element of allElements) {
      if (shouldStripElement(element)) {
        toRemove.push(element);
      }
    }

    // Remove collected elements
    for (const element of toRemove) {
      element.remove();
    }

    return document.documentElement?.outerHTML ?? withoutComments;
  } catch {
    // Fallback: just return without comments if parsing fails
    return withoutComments;
  }
}

/**
 * Strip invisible Unicode characters that could carry hidden payloads.
 *
 * Removes:
 * - Zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
 * - Directional override characters (U+202A-U+202E, U+2066-U+2069)
 * - Unicode tag characters (U+E0000-U+E007F)
 */
export function stripInvisibleUnicode(text: string): string {
  if (!text) {
    return text;
  }

  return (
    text
      // Zero-width characters
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
      // Directional overrides
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
      // Unicode tag characters (U+E0000-U+E007F)
      .replace(/[\u{E0000}-\u{E007F}]/gu, "")
  );
}

/**
 * Sanitize extracted content by stripping all human-invisible text.
 */
export async function sanitizeExtractedContent(html: string): Promise<string> {
  const stripped = await stripHiddenHtml(html);
  return stripInvisibleUnicode(stripped);
}

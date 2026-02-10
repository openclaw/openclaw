/**
 * Transform standard Markdown to WhatsApp-compatible formatting.
 *
 * WhatsApp uses its own formatting syntax:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (same as standard)
 * - Strikethrough: ~text~ (not ~~text~~)
 * - Code: ```code``` (supported) and `code` (not supported inline)
 * - Links: not supported as [text](url), rendered as plain text
 * - Headers: not supported, converted to bold
 *
 * @see https://faq.whatsapp.com/general/chats/how-to-format-your-messages
 */

type CodeBlock = {
  placeholder: string;
  content: string;
};

/**
 * Protect code blocks and inline code from transformation.
 * Uses numbered placeholders that won't collide with bold/italic patterns.
 */
function protectCodeBlocks(text: string): { text: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  let result = text;

  // Protect fenced code blocks first (```...```)
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `%%CODEBLOCK_${blocks.length}%%`;
    blocks.push({ placeholder, content: match });
    return placeholder;
  });

  // Protect inline code (`...`)
  result = result.replace(/`[^`\n]+`/g, (match) => {
    const placeholder = `%%INLINECODE_${blocks.length}%%`;
    blocks.push({ placeholder, content: match });
    return placeholder;
  });

  return { text: result, blocks };
}

/**
 * Restore protected code blocks.
 */
function restoreCodeBlocks(text: string, blocks: CodeBlock[]): string {
  let result = text;
  for (const block of blocks) {
    result = result.replace(block.placeholder, block.content);
  }
  return result;
}

/**
 * Convert standard Markdown bold (**text** or __text__) to WhatsApp bold (*text*).
 */
function convertBold(text: string): string {
  // Convert **text** to *text*
  let result = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Convert __text__ to *text*
  result = result.replace(/__(.+?)__/g, "*$1*");
  return result;
}

/**
 * Convert standard Markdown strikethrough (~~text~~) to WhatsApp strikethrough (~text~).
 */
function convertStrikethrough(text: string): string {
  return text.replace(/~~(.+?)~~/g, "~$1~");
}

/**
 * Convert Markdown headers (# Heading) to WhatsApp bold (*Heading*).
 */
function convertHeaders(text: string): string {
  // Match lines starting with 1-6 # characters
  return text.replace(/^(#{1,6})\s+(.+)$/gm, "*$2*");
}

/**
 * Convert Markdown links [text](url) to WhatsApp-friendly format.
 * WhatsApp doesn't support clickable markdown links, so we render as "text (url)" or just the URL.
 */
function convertLinks(text: string): string {
  // Convert [text](url) to "text (url)" if text differs from url, else just url
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const trimmedText = linkText.trim();
    const trimmedUrl = url.trim();
    // If link text is same as URL or empty, just show URL
    if (!trimmedText || trimmedText === trimmedUrl) {
      return trimmedUrl;
    }
    return `${trimmedText} (${trimmedUrl})`;
  });
}

/**
 * Convert Markdown images ![alt](url) to WhatsApp-friendly format.
 */
function convertImages(text: string): string {
  // Convert ![alt](url) to "alt (url)" or just url
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const trimmedAlt = alt.trim();
    const trimmedUrl = url.trim();
    if (!trimmedAlt) {
      return trimmedUrl;
    }
    return `${trimmedAlt} (${trimmedUrl})`;
  });
}

/**
 * Remove horizontal rules (---, ***, ___) as WhatsApp doesn't support them.
 */
function removeHorizontalRules(text: string): string {
  return text.replace(/^[-*_]{3,}\s*$/gm, "");
}

/**
 * Collapse excessive blank lines (more than 2) to max 2.
 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Transform standard Markdown to WhatsApp-compatible formatting.
 *
 * @param markdown - The markdown text to transform
 * @returns WhatsApp-compatible formatted text
 */
export function transformMarkdownForWhatsApp(markdown: string): string {
  if (!markdown) {
    return markdown;
  }

  // Step 1: Protect code blocks from transformation
  const { text: protectedText, blocks } = protectCodeBlocks(markdown);

  // Step 2: Apply transformations
  let result = protectedText;
  result = convertHeaders(result);
  result = convertImages(result);
  result = convertLinks(result);
  result = convertBold(result);
  result = convertStrikethrough(result);
  result = removeHorizontalRules(result);
  result = collapseBlankLines(result);

  // Step 3: Restore code blocks
  result = restoreCodeBlocks(result, blocks);

  return result;
}

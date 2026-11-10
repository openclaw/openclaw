export const CODE_PREVIEW_LINE_COUNT = 7;

type CodeHighlightChunk = { html: string; to: number };
export type CodeHighlightRequest = { id: number; source: string; language: string };
export type CodeHighlightReply = {
  id: number;
  chunks: CodeHighlightChunk[] | null;
  previewEnd: number;
  highlighted: boolean;
};

/** Split generated hljs markup without splitting lexical state or escaped characters. */
export function splitCodeHighlightHtml(html: string) {
  const chunks: CodeHighlightChunk[] = [];
  const scopes: string[] = [];
  let body = "";
  let from = 0;
  let offset = 0;
  let spans = 0;
  let lines = 0;
  let previewEnd: number | undefined;
  const flush = () => {
    if (offset === from) {
      return;
    }
    chunks.push({ html: body + "</span>".repeat(scopes.length), to: offset });
    body = scopes.join("");
    spans = scopes.length;
    from = offset;
  };
  // The highlighter emits only span/class markup and these five HTML escapes.
  // Every chunk still passes the existing DOMPurify boundary on the main thread.
  for (const [part] of html.matchAll(
    /<span class="[^"]*">|<\/span>|&(?:amp|lt|gt|quot|#x27);|[\s\S]/gu,
  )) {
    if (part.startsWith("<span ")) {
      if (spans >= 128) {
        flush();
      }
      scopes.push(part);
      spans += 1;
    } else if (part === "</span>") {
      scopes.pop();
    } else {
      offset += part.startsWith("&") && part.endsWith(";") ? 1 : part.length;
    }
    body += part;
    if (part === "\n" && ++lines === CODE_PREVIEW_LINE_COUNT) {
      previewEnd = offset;
      flush();
    } else if (offset - from >= 2_048) {
      flush();
    }
  }
  flush();
  return { chunks, previewEnd: previewEnd ?? offset };
}

import { listen } from "../lib/reactive/listener.ts";
import {
  splitCodeHighlightHtml,
  type CodeHighlightReply,
  type CodeHighlightRequest,
} from "./markdown-code-highlight-chunks.ts";
import { highlightCodeHtml } from "./markdown-highlight-runtime.ts";

listen(globalThis, "message", ({ data }: MessageEvent<CodeHighlightRequest>) => {
  let reply: CodeHighlightReply;
  try {
    const html = highlightCodeHtml(data.source, data.language);
    const highlighted = html.includes("hljs-");
    reply = {
      id: data.id,
      ...(highlighted ? splitCodeHighlightHtml(html) : { chunks: [], previewEnd: 0 }),
      highlighted,
    };
  } catch {
    reply = { id: data.id, chunks: null, previewEnd: 0, highlighted: false };
  }
  globalThis.postMessage(reply, { transfer: [] });
});

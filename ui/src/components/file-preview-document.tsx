import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { stripFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SanitizedHtml } from "./solid/sanitized-html.tsx";

/** Shared read-only rendering; callers retain file-read and overlay ownership. */
export function FilePreviewDocument(props: {
  path: string;
  content: string;
  message?: string;
  markdown?: boolean;
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
}) {
  const chunks = createMemo(() => chunkFileContents(props.content));
  const html = createMemo(() =>
    toSanitizedMarkdownHtml(stripFrontmatterBlock(props.content), {
      mode: "document",
      remoteImages: false,
      codeBlockChrome: "none",
      fileLinks: false,
    }),
  );
  return (
    <Show when={!props.message} fallback={<p role="status">{props.message}</p>}>
      <Show
        when={props.markdown && /\.md$/iu.test(props.path)}
        fallback={
          <div class="code-content">
            <For each={chunks()}>
              {(chunk, index) => (
                <pre class="code-chunk" data-chunk={index()}>
                  {chunk}
                </pre>
              )}
            </For>
          </div>
        }
      >
        <SanitizedHtml tag="article" class="markdown" onClick={props.onClick} html={html()} />
      </Show>
    </Show>
  );
}

/** Keep package-relative links inside the caller’s included file inventory. */
export function filePreviewDocumentLink(event: MouseEvent, path: string): string | null {
  const anchor =
    event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  const href = anchor?.getAttribute("href");
  if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(href)) {
    return null;
  }
  event.preventDefault();
  const target = new URL(href, new URL(path, "https://skill.invalid/"));
  try {
    return decodeURIComponent(target.pathname.slice(1));
  } catch {
    return null;
  }
}

function chunkFileContents(contents: string): string[] {
  const lines = contents.split("\n");
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 64) {
    chunks.push(lines.slice(index, index + 64).join("\n"));
  }
  return chunks;
}

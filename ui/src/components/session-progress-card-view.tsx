import { createMemo, Show } from "solid-js";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { promoteFirstProgressBar } from "./session-progress-card.ts";

export function ProgressCardMarkdown(props: { markdown?: string; promoteProgress?: boolean }) {
  const sanitized = createMemo(() => {
    i18nRevision();
    const html = props.markdown
      ? toSanitizedMarkdownHtml(props.markdown, { progressBars: true })
      : "";
    return props.promoteProgress ? promoteFirstProgressBar(html) : html;
  });
  const container = document.createElement("div");
  container.className = "session-progress-card__markdown sidebar-markdown";
  const markdown = createMarkdownRef(() => ({ content: sanitized() }));
  markdown(container);
  return <Show when={props.markdown}>{container}</Show>;
}

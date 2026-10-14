import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { promoteFirstProgressBar, sanitizedProgressMarkdown } from "./session-progress-card.ts";

export function ProgressCardMarkdown(props: { markdown?: string; promoteProgress?: boolean }) {
  const sanitized = createMemo(() => {
    const html = props.markdown ? sanitizedProgressMarkdown(props.markdown) : "";
    return props.promoteProgress ? promoteFirstProgressBar(html) : html;
  });
  const container = document.createElement("div");
  container.className = "session-progress-card__markdown sidebar-markdown";
  const markdown = new MarkdownDomReconciler(container);
  createEffect(sanitized, (html) => markdown.updateHtml(html));
  onCleanup(() => markdown.dispose());
  return <Show when={props.markdown}>{container}</Show>;
}

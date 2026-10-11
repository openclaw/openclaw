import { createEffect, createSignal, onCleanup } from "solid-js";
import { MarkdownDomReconciler, type MarkdownDomMedia } from "../lib/markdown-dom-reconciler.ts";

export type MarkdownContentValue =
  | string
  | { messageKey: string; source: string; parts: readonly [string, string] };

/** Bind a sanitized Markdown island without letting Solid render inside it. */
export function createMarkdownRef(
  read: () => {
    content: MarkdownContentValue;
    media?: MarkdownDomMedia;
    incremental?: boolean;
    connected?: boolean;
  },
): (element: ParentNode) => void {
  // Fragment consumers attach during construction; ordinary element refs run unowned.
  const [owner, setOwner] = createSignal<MarkdownDomReconciler | undefined>(undefined, {
    ownedWrite: true,
  });
  let current: MarkdownDomReconciler | undefined;
  createEffect(
    () => [owner(), read()] as const,
    ([reconciler, value]) => {
      if (!reconciler) return;
      reconciler.setConnected(value.connected ?? true);
      if (typeof value.content === "string") {
        reconciler.updateHtml(value.content, value.media, value.incremental);
      } else {
        const { messageKey, source, parts } = value.content;
        reconciler.update(messageKey, source, parts, value.media);
      }
    },
  );
  onCleanup(() => current?.dispose());
  return (element) => {
    current?.dispose();
    // Create the boundary synchronously so a fragment caller can return its markers.
    current = new MarkdownDomReconciler(element);
    setOwner(current);
  };
}

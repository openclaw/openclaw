import { createEffect, createSignal, onCleanup, useContext } from "solid-js";
import { MarkdownDomReconciler, type MarkdownDomMedia } from "../lib/markdown-dom-reconciler.ts";
import { HovercardControlsContext } from "./portaled-hovercard-focus.ts";
import { registerSessionTitleTarget } from "./session-title-target-registration.ts";

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
    onUpdate?: () => void;
  },
): (element: ParentNode) => void {
  // Fragment consumers attach during construction; ordinary element refs run unowned.
  const [owner, setOwner] = createSignal<MarkdownDomReconciler | undefined>(undefined, {
    ownedWrite: true,
  });
  let current: MarkdownDomReconciler | undefined;
  const releaseControls = useContext(HovercardControlsContext)?.registerSource(
    () => current?.focusableControls() ?? [],
  );
  createEffect(
    () => [owner(), read()] as const,
    ([reconciler, value]) => {
      if (!reconciler) {
        return;
      }
      reconciler.setConnected(value.connected ?? true);
      if (typeof value.content === "string") {
        reconciler.updateHtml(value.content, value.media, value.incremental);
      } else {
        const { messageKey, source, parts } = value.content;
        reconciler.update(messageKey, source, parts, value.media);
      }
      value.onUpdate?.();
    },
  );
  onCleanup(() => {
    releaseControls?.();
    current?.dispose();
  });
  return (element) => {
    current?.dispose();
    // Create the boundary synchronously so a fragment caller can return its markers.
    current = new MarkdownDomReconciler(element, registerSessionTitleTarget);
    setOwner(current);
  };
}

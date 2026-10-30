import { createEffect, createSignal, onCleanup } from "solid-js";
import type { ChatRowDisplay } from "../lib/chat/row-display-facts.ts";
import type { MarkdownContent } from "../lib/markdown-content.ts";
import { MarkdownDomReconciler, type MarkdownDomMedia } from "../lib/markdown-dom-reconciler.ts";
import {
  MARKDOWN_LINK_DISPLAY_TARGET_SELECTOR,
  registerSessionTitleTarget,
} from "./markdown-link-display.ts";

export type MarkdownContentValue =
  | MarkdownContent
  | {
      messageKey: string;
      source: string;
      parts:
        | readonly [MarkdownContent, MarkdownContent]
        | (() => readonly [MarkdownContent, MarkdownContent]);
      deferFormatting?: boolean;
    };

/** Bind a sanitized Markdown island without letting Solid render inside it. */
export function createMarkdownRef(
  read: () => {
    content: MarkdownContentValue;
    media?: MarkdownDomMedia;
    incremental?: boolean;
    connected?: boolean;
    onUpdate?: () => void;
  },
  display?: (() => ChatRowDisplay | undefined) | null,
): (element: ParentNode) => void {
  // Fragment consumers attach during construction; ordinary element refs run unowned.
  const [owner, setOwner] = createSignal<MarkdownDomReconciler | undefined>(undefined, {
    ownedWrite: true,
  });
  let current: MarkdownDomReconciler | undefined;
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingPreview = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pendingPreview = false;
  };
  createEffect(
    () => {
      tick();
      const reconciler = owner();
      const value = read();
      const content = value.content;
      const preview = Boolean(
        reconciler &&
        typeof content !== "string" &&
        !("fragment" in content) &&
        content.deferFormatting &&
        !value.media &&
        timer !== undefined &&
        reconciler.canPreview(content.messageKey, content.source),
      );
      // Formatting stays in the tracked phase: late code highlighting must still invalidate it.
      const parts =
        reconciler && !preview && typeof content !== "string" && !("fragment" in content)
          ? typeof content.parts === "function"
            ? content.parts()
            : content.parts
          : undefined;
      return { reconciler, value, preview, parts };
    },
    ({ reconciler, value, preview, parts }) => {
      if (!reconciler) {
        return;
      }
      reconciler.setConnected(value.connected ?? true);
      const content = value.content;
      if (preview && typeof content !== "string" && !("fragment" in content)) {
        reconciler.preview(content.source);
        pendingPreview = true;
        return;
      }
      cancel();
      if (typeof content === "string" || "fragment" in content) {
        reconciler.updateHtml(content, value.media, value.incremental);
      } else {
        reconciler.update(content.messageKey, content.source, parts!, value.media);
      }
      if (
        typeof content !== "string" &&
        !("fragment" in content) &&
        content.deferFormatting &&
        !value.media
      ) {
        // Text stays immediate; a burst shares one bounded formatting window.
        timer = setTimeout(() => {
          timer = undefined;
          if (pendingPreview) {
            pendingPreview = false;
            setTick((previous) => previous + 1);
          }
        }, 50);
      }
      value.onUpdate?.();
    },
  );
  onCleanup(() => {
    cancel();
    current?.dispose();
  });
  return (element) => {
    cancel();
    current?.dispose();
    // Create the boundary synchronously so a fragment caller can return its markers.
    current = new MarkdownDomReconciler(
      element,
      display
        ? (target, label) => registerSessionTitleTarget(target, label, display())
        : registerSessionTitleTarget,
      display ? MARKDOWN_LINK_DISPLAY_TARGET_SELECTOR : undefined,
    );
    setOwner(current);
  };
}

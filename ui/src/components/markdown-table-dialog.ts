import { t } from "../i18n/index.ts";
import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createIconElement } from "./markdown-icon.ts";
import {
  getRenderedMarkdownMathSource,
  rememberRenderedMarkdownMathSource,
} from "./markdown-math-element.ts";
import "./modal-dialog.tsx";

export function mountExpandedMarkdownTable(
  dialog: HTMLElementTagNameMap["openclaw-modal-dialog"],
  table: HTMLTableElement,
  trigger: HTMLElement,
  owner: HTMLElement,
  close: () => void,
  stopListeners: Array<() => void>,
) {
  dialog.className = "markdown-table-modal";
  dialog.label = t("common.expandedTable");
  dialog.setReturnFocusTarget(trigger);
  const dismissLink = (event: Event) => {
    const anchor = anchorFromNavigationEvent(event);
    if (!anchor || (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    // Listener microtasks can precede ancestor routing. Defer removal until
    // routing and the browser's default href activation have finished.
    setTimeout(() => {
      if (
        event.type === "click" ||
        event.defaultPrevented ||
        (event instanceof MouseEvent && event.button === 1 && anchor.hasAttribute("href"))
      ) {
        close();
      }
    }, 0);
  };
  stopListeners.push(listen(dialog, "modal-cancel", close));
  const content = document.createElement("div");
  content.className = "markdown-table-dialog chat-text";
  content.dir = getComputedStyle(table).direction;
  for (const event of ["click", "auxclick", "keydown"]) {
    stopListeners.push(listen(content, event, dismissLink));
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "markdown-table-dialog__close";
  dismiss.setAttribute("aria-label", t("common.closeTable"));
  dismiss.autofocus = true;
  dialog.initialFocus = () => dismiss;
  stopListeners.push(listen(dismiss, "click", close));
  dismiss.append(createIconElement("x", document));
  const copy = table.ownerDocument.importNode(table, true);
  const originals = table.getElementsByTagName("openclaw-markdown-math");
  const copies = copy.getElementsByTagName("openclaw-markdown-math");
  for (let index = 0; index < originals.length; index += 1) {
    const source = getRenderedMarkdownMathSource(originals[index]!);
    if (source) {
      rememberRenderedMarkdownMathSource(copies[index]!, source);
    }
  }
  content.append(dismiss, copy);
  dialog.append(content);
  // Keep delegated file/session actions and modal teardown with their transcript.
  owner.append(dialog);
  return content;
}

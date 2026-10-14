import "./tooltip.ts";
import { formatUiError } from "../lib/format-error.ts";
import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import { showToast } from "../lib/toast.ts";
import { ownsHoverPreview } from "./link-reader-hovercard-registration.ts";
import { collectTooltipNameText, isTooltipTriggerElement } from "./tooltip-content.ts";
import { resolveTransientContainer } from "./transient-container.ts";

function titleNamesElement(element: Element) {
  if (
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby") ||
    element.matches("img[alt], input[alt]") ||
    collectTooltipNameText(element).trim()
  ) {
    return false;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return (
      !element.labels?.length &&
      !element.matches('input[type="button"], input[type="submit"], input[type="reset"]')
    );
  }
  return true;
}

/** `title` remains a declarative hint source; only the shared Tooltip renders it. */
export function installTitleTooltips(ownerDocument: Document) {
  let tooltip: HTMLElementTagNameMap["openclaw-tooltip"] | null = null;
  let active: {
    anchor: HTMLElement | SVGElement;
    link: HTMLAnchorElement | null;
    previewOwned: boolean;
    filePath: string | null;
    disposeFileContent?: () => void;
    title: string | null;
    label: string | null;
    pointer: boolean;
    focus: boolean;
  } | null = null;

  const restore = () => {
    if (!active) {
      return;
    }
    const { anchor, title, label, disposeFileContent } = active;
    active = null;
    disposeFileContent?.();
    observer.disconnect();
    anchor.removeEventListener("pointerleave", handlePointerLeave);
    anchor.removeEventListener("focusout", handleFocusOut);
    if (title !== null && anchor.getAttribute("title") === "") {
      anchor.setAttribute("title", title);
    }
    if (label !== null && anchor.getAttribute("aria-label") === label) {
      anchor.removeAttribute("aria-label");
    }
    if (tooltip) {
      tooltip.anchor = null;
      tooltip.remove();
      tooltip = null;
    }
  };

  // Preview eligibility owns the hint before its lazy runtime or request settles.
  // Title suppression and accessible naming still use the normal restoration lifecycle.
  const ownsPreview = (link: HTMLAnchorElement | null | undefined) =>
    Boolean(link && ownsHoverPreview(link));
  const content = () => {
    if (ownsPreview(active?.link)) {
      return "";
    }
    return active?.anchor.matches('[aria-haspopup="dialog"][aria-expanded="true"]')
      ? ""
      : (active?.anchor.getAttribute("data-tooltip") ?? active?.title ?? "");
  };
  const update = (records: MutationRecord[]) => {
    if (!active) {
      return;
    }
    if (
      !active.anchor.isConnected ||
      active.anchor.getAttribute("data-file-path") !== active.filePath
    ) {
      restore();
      return;
    }
    // Reparenting changes eligibility even when mutation targets are ancestors.
    if (ownsPreview(active.link)) {
      active.previewOwned = true;
      if (tooltip) {
        tooltip.content = "";
      }
    }
    if (
      !records.some(
        (record) => active?.anchor.contains(record.target) || record.target === active?.link,
      )
    ) {
      return;
    }
    if (
      records.some((record) => record.target === active?.anchor && record.attributeName === "title")
    ) {
      active.title = active.anchor.getAttribute("title");
      if (active.title !== null) {
        active.anchor.setAttribute("title", "");
        // Drop only our synchronous suppression write; a real empty title must
        // still clear a disabled reason or a completed action's previous hint.
        observer.takeRecords();
      }
    }
    if (active.label !== null && active.anchor.getAttribute("aria-label") === active.label) {
      active.anchor.removeAttribute("aria-label");
      active.label = null;
    }
    if (active.title && titleNamesElement(active.anchor)) {
      active.label = active.title;
      active.anchor.setAttribute("aria-label", active.label);
    }
    if (tooltip && !active.filePath) {
      // Updates refresh an open hint, never reopen a dismissed action. Reentry
      // or keyboard focus supplies new intent after an empty title clears it.
      tooltip.content = content();
    }
  };
  const observer = new MutationObserver(update);
  const handlePointerLeave = (event: Event) => {
    if (!active || event.target !== active.anchor) {
      return;
    }
    active.pointer = false;
    if (!active.focus && !active.filePath) {
      restore();
    }
  };
  const handleFocusOut = (event: Event) => {
    if (
      !active ||
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        active.anchor.contains(event.relatedTarget))
    ) {
      return;
    }
    active.focus = false;
    if (!active.pointer && !active.filePath) {
      restore();
    }
  };
  const discover = (event: Event) => {
    if ("pointerType" in event && event.pointerType === "touch") {
      return;
    }
    // Rich content stays under the shared tooltip lifecycle, not title discovery.
    if (active?.filePath && event.composedPath().includes(tooltip!)) {
      return;
    }
    const elements = event.composedPath().filter(isTooltipTriggerElement);
    const link = anchorFromNavigationEvent(event);
    // Iframe titles name browsing contexts, not hints. Explicit wrappers already
    // own their trigger; adapting those again would create competing popups.
    const explicit = elements.some((element) => element.localName === "openclaw-tooltip");
    let anchor: HTMLElement | SVGElement | undefined;
    for (const element of elements) {
      if (element.localName === "iframe") {
        break;
      }
      const title = element === active?.anchor ? active.title : element.getAttribute("title");
      const hint =
        element.getAttribute("data-file-path") ?? element.getAttribute("data-tooltip") ?? title;
      if (hint !== null) {
        anchor = hint ? element : undefined;
        break;
      }
    }
    const input = event.type === "focusin" ? "focus" : "pointer";
    const previewOwned = ownsPreview(link);
    if (anchor === active?.anchor && previewOwned === active?.previewOwned) {
      if (active) {
        active.link = link;
        active[input] = true;
        if (link && !active.anchor.contains(link)) {
          observer.observe(link, { attributes: true, attributeFilter: ["href"] });
        }
      }
      return;
    }
    if (!anchor && (active?.filePath || (active?.focus && input === "pointer"))) {
      return;
    }
    restore();
    if (!anchor) {
      return;
    }
    const title = anchor.getAttribute("title");
    const label = title && titleNamesElement(anchor) ? title : null;
    active = {
      anchor,
      link,
      previewOwned,
      filePath: anchor.getAttribute("data-file-path"),
      title,
      label,
      pointer: input === "pointer",
      focus: input === "focus",
    };
    if (title !== null) {
      // An empty title blocks browser inheritance without exposing the next ancestor.
      anchor.setAttribute("title", "");
    }
    if (label !== null) {
      anchor.setAttribute("aria-label", label);
    }
    anchor.addEventListener("pointerleave", handlePointerLeave);
    anchor.addEventListener("focusout", handleFocusOut);
    observer.observe(anchor, {
      attributes: true,
      attributeFilter: [
        "title",
        "data-tooltip",
        "data-file-path",
        "aria-hidden",
        "aria-haspopup",
        "aria-expanded",
        "href",
      ],
      characterData: true,
      subtree: true,
    });
    if (link && !anchor.contains(link)) {
      observer.observe(link, { attributes: true, attributeFilter: ["href"] });
    }
    observer.observe(ownerDocument, { childList: true, subtree: true });
    const root = anchor.getRootNode();
    if (root instanceof ShadowRoot) {
      observer.observe(root, { childList: true, subtree: true });
    }
    const tooltipContent = active.filePath ?? content();
    if (!explicit && tooltipContent) {
      tooltip ??= ownerDocument.createElement("openclaw-tooltip");
      if (active.filePath) {
        const current = active;
        const path = active.filePath;
        const slot = ownerDocument.createElement("span");
        slot.slot = "content";
        slot.className = "markdown-file-tooltip";
        slot.textContent = path;
        tooltip.append(slot);
        // Inline ownership preserves native Tab order without moving the file link.
        anchor.after(tooltip);
        tooltip.previewForAnchor(anchor, "", input);
        void import("./markdown-file-tooltip.ts")
          .then(({ renderMarkdownFileTooltip }) => {
            if (active === current && slot.isConnected) {
              current.disposeFileContent = renderMarkdownFileTooltip(slot, path);
            }
          })
          .catch((error: unknown) => {
            if (active === current) {
              restore();
              showToast({ message: formatUiError(error) });
            }
          });
        return;
      }
      const mount = resolveTransientContainer(event.composedPath(), ownerDocument);
      if (!mount) {
        restore();
        return;
      }
      mount.append(tooltip);
      tooltip.previewForAnchor(anchor, tooltipContent, input);
    }
  };
  ownerDocument.addEventListener("pointerover", discover, true);
  ownerDocument.addEventListener("focusin", discover, true);
  return () => {
    ownerDocument.removeEventListener("pointerover", discover, true);
    ownerDocument.removeEventListener("focusin", discover, true);
    restore();
  };
}

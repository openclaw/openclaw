import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { ChatLinkDisplay, ChatRowDisplay } from "../lib/chat/row-display-facts.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";

export type SessionTitleDisplay = {
  title?: string;
  onTitle: (title: string | undefined) => void;
};

/** An absent title prepares the link while leaving its producer-owned label intact. */
export function stampSessionTitleLabel(
  element: HTMLElement,
  label: HTMLElement,
  title?: string,
): HTMLElement {
  let anchor = element;
  if (
    !(element instanceof HTMLAnchorElement) &&
    !element.hasAttribute("data-session-title-only") &&
    (element.classList.contains("markdown-session-link") ||
      (title && element.hasAttribute("data-session-href")))
  ) {
    anchor = document.createElement("a");
    for (const name of ["data-session-href", "data-session-key"]) {
      const value = element.getAttribute(name);
      if (value) {
        anchor.setAttribute(name, value);
      }
    }
    anchor.setAttribute("href", element.getAttribute("href") ?? element.dataset.sessionHref ?? "");
    anchor.className = "markdown-session-link";
    element.classList.remove("markdown-session-link");
    element.removeAttribute("href");
    element.removeAttribute("data-session-href");
    element.replaceWith(anchor);
    anchor.append(element);
  }
  if (title) {
    if (!anchor.classList.contains("markdown-session-link--titled")) {
      anchor.classList.add("markdown-session-link--titled");
    }
    if (label.className !== "session-label") {
      label.className = "session-label";
    }
    if (label.textContent !== title) {
      label.textContent = title;
    }
    if (anchor.firstChild !== label || anchor.childNodes.length !== 1) {
      anchor.replaceChildren(label);
    }
  }
  return anchor;
}

// Producers can mount before the app's lazy hovercard bootstrap has loaded.
const { promise: registrar, resolve: installSessionTitleRegistrar } =
  Promise.withResolvers<
    (target: HTMLElement, label: HTMLElement, display?: SessionTitleDisplay) => () => void
  >();

export { installSessionTitleRegistrar };

export const MARKDOWN_LINK_DISPLAY_TARGET_SELECTOR = `${SESSION_TITLE_TARGET_SELECTOR}, a.markdown-github-item`;

const linkReaderDisplays = new WeakMap<
  HTMLElement,
  { read: () => ChatLinkDisplay | undefined; write: (value: ChatLinkDisplay) => void }
>();

function linkDisplayKey(target: HTMLElement): string | undefined {
  if (target.dataset.sessionKey && !target.dataset.sessionHref) {
    return `session:${target.dataset.sessionKey}`;
  }
  const raw = target.dataset.sessionHref ?? target.getAttribute("href");
  const url = raw ? URL.parse(raw, globalThis.location.href) : null;
  const reader = target.classList.contains("markdown-github-item");
  // Session titles are path-only. Reader queries may change the answer or carry credentials.
  return url &&
    !url.username &&
    !url.password &&
    !(reader && url.search) &&
    /^https?:$/u.test(url.protocol)
    ? `${reader ? "pr" : "session"}:${url.origin}${url.pathname}`
    : undefined;
}

export function registerSessionTitleTarget(
  target: HTMLElement,
  label: HTMLElement,
  display?: ChatRowDisplay,
): () => void {
  const key = display && linkDisplayKey(target);
  const read = () => (key ? display?.read()?.facts?.links?.[key] : undefined);
  const write = (value: ChatLinkDisplay) => {
    const previous = read();
    if (
      previous?.title === value.title &&
      previous?.badge?.label === value.badge?.label &&
      previous?.badge?.tone === value.badge?.tone
    ) {
      return;
    }
    if (
      key &&
      (!target.classList.contains("markdown-github-item") || linkDisplayKey(target) === key)
    ) {
      const links = { ...display?.read()?.facts?.links };
      if (value.title || value.badge) {
        links[key] = value;
      } else {
        delete links[key];
      }
      display?.write({ links });
    }
  };
  if (target.classList.contains("markdown-github-item")) {
    if (display && key) {
      linkReaderDisplays.set(target, { read, write });
      updateLinkReaderDisplay(target);
    }
    return () => linkReaderDisplays.delete(target);
  }
  const title = read()?.title;
  const registeredTarget = title ? stampSessionTitleLabel(target, label, title) : target;
  let active = true;
  let release: (() => void) | undefined;
  void registrar.then((register) => {
    if (active) {
      release = display
        ? register(registeredTarget, label, {
            title,
            onTitle: (title) => write({ ...read(), title }),
          })
        : register(registeredTarget, label);
    }
  });
  return () => {
    active = false;
    release?.();
  };
}

/** The existing reader owns fresh metadata; this binding records only its inline display. */
export function updateLinkReaderDisplay(
  anchor: HTMLElement,
  preview?: ControlUiLinkReaderPreview,
): void {
  const display = linkReaderDisplays.get(anchor);
  const badge = preview ? preview.badge : display?.read()?.badge;
  if (badge) {
    if (anchor.getAttribute("aria-description") !== badge.label) {
      anchor.setAttribute("aria-description", badge.label);
    }
    if (anchor.dataset.linkReaderTone !== badge.tone) {
      anchor.dataset.linkReaderTone = badge.tone;
    }
  } else {
    delete anchor.dataset.linkReaderTone;
    anchor.removeAttribute("aria-description");
  }
  if (preview) {
    display?.write({
      title: preview.title,
      ...(badge ? { badge: { label: badge.label, tone: badge.tone } } : {}),
    });
  }
}

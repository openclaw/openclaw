import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { ChatLinkDisplay, ChatRowDisplay } from "../lib/chat/row-display-facts.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";
import { registerSessionTitleTarget } from "./session-title-target-registration.ts";

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

export function registerMarkdownLinkDisplay(
  target: HTMLElement,
  label: HTMLElement,
  display: ChatRowDisplay | undefined,
): () => void {
  const key = linkDisplayKey(target);
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
  if (!target.classList.contains("markdown-github-item")) {
    return registerSessionTitleTarget(target, label, {
      title: read()?.title,
      onTitle: (title) => write({ ...read(), title }),
    });
  }
  if (display && key) {
    linkReaderDisplays.set(target, { read, write });
    updateLinkReaderDisplay(target);
  }
  return () => linkReaderDisplays.delete(target);
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

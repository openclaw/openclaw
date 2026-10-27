export type SessionTitleDisplay = {
  title?: string;
  onTitle: (title: string | undefined) => void;
};

export function sessionTitleAnchor(element: HTMLElement, knownTitle = false): HTMLElement {
  if (
    element instanceof HTMLAnchorElement ||
    element.hasAttribute("data-session-title-only") ||
    (!element.classList.contains("markdown-session-link") &&
      !(knownTitle && element.hasAttribute("data-session-href")))
  ) {
    return element;
  }
  const anchor = document.createElement("a");
  if (element.dataset.sessionHref) {
    anchor.dataset.sessionHref = element.dataset.sessionHref;
  }
  if (element.dataset.sessionKey) {
    anchor.dataset.sessionKey = element.dataset.sessionKey;
  }
  anchor.setAttribute("href", element.getAttribute("href") ?? element.dataset.sessionHref ?? "");
  anchor.className = "markdown-session-link";
  element.classList.remove("markdown-session-link");
  element.removeAttribute("href");
  element.removeAttribute("data-session-href");
  element.replaceWith(anchor);
  anchor.append(element);
  return anchor;
}

export function stampSessionTitleLabel(anchor: HTMLElement, label: HTMLElement, title: string) {
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

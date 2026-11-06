/** Keep in sync with the `[data-sidebar-archive-exiting]` transitions in layout.css. */
const EXIT_DURATION_MS = 240;
const EXIT_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const exitsByList = new WeakMap<HTMLElement, number>();

/**
 * Plays a short exit for a sidebar session the user just archived.
 *
 * The roster still owns membership and removes the live row immediately. When
 * that row's tree unmounts while `archive` is in flight, an inert copy takes its
 * place and fades out while the remaining rows glide into the gap. Removals
 * after the archive settles (refreshes, failures, cancelled confirmations) are
 * not animated. Archiving the last row of a section unmounts the whole list, so
 * that case stays instant.
 */
export function playSidebarArchiveExit<T>(sessionKey: string, archive: Promise<T>): Promise<T> {
  const view = globalThis.window;
  if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return archive;
  }
  const tree = view.document.querySelector<HTMLElement>(
    `.sidebar-session-tree[data-session-tree="${CSS.escape(sessionKey)}"]`,
  );
  const list = tree?.parentElement;
  // DOM shims without Web Animations (jsdom) keep the instant removal.
  if (!tree || !list || typeof tree.animate !== "function") {
    return archive;
  }
  const height = tree.getBoundingClientRect().height;
  // Flag the list before the roster moves its rows: the window measures layout
  // right after removing a row, so a later flag would miss that style change.
  holdExit(list);
  let removed = false;
  const observer = new MutationObserver((records) => {
    const removal = records.find((record) => [...record.removedNodes].includes(tree));
    if (removal) {
      removed = true;
      observer.disconnect();
      insertExitCopy(tree, height, list, removal.nextSibling);
    }
  });
  observer.observe(list, { childList: true });
  // Solid applies the optimistic removal before the next frame; stop afterward.
  const stop = () =>
    view.requestAnimationFrame(() => {
      observer.disconnect();
      if (!removed) {
        releaseExit(list);
      }
    });
  archive.then(stop, stop);
  return archive;
}

function holdExit(list: HTMLElement) {
  exitsByList.set(list, (exitsByList.get(list) ?? 0) + 1);
  list.dataset.sidebarArchiveExiting = "";
}

function releaseExit(list: HTMLElement) {
  const remaining = (exitsByList.get(list) ?? 1) - 1;
  exitsByList.set(list, remaining);
  if (remaining === 0) {
    delete list.dataset.sidebarArchiveExiting;
  }
}

function insertExitCopy(tree: HTMLElement, height: number, list: HTMLElement, next: Node | null) {
  const copy = tree.cloneNode(true) as HTMLElement;
  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const name of ["id", "data-session-key", "data-session-tree", "data-session-window-key"]) {
      element.removeAttribute(name);
    }
  }
  copy.dataset.sidebarArchiveExit = "";
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  list.insertBefore(copy, next?.parentNode === list ? next : null);
  const fade = { opacity: 0, translate: "-10px 0", scale: "0.98", filter: "blur(1.5px)" };
  // Windowed lists position rows absolutely, so their neighbors glide by
  // transition. In-flow lists need the copy itself to give its slot back.
  const keyframes = list.classList.contains("sidebar-session-window")
    ? [{ opacity: 1, translate: "0 0", scale: "1", filter: "blur(0)" }, fade]
    : [
        { opacity: 1, translate: "0 0", scale: "1", filter: "blur(0)", height: `${height}px` },
        { ...fade, height: `${height}px`, offset: 0.5 },
        {
          ...fade,
          height: "0px",
          marginBottom: `${-Number.parseFloat(getComputedStyle(list).rowGap) || 0}px`,
        },
      ];
  copy.style.overflow = "hidden";
  const animation = copy.animate(keyframes, {
    duration: EXIT_DURATION_MS,
    easing: EXIT_EASING,
    fill: "forwards",
  });
  const finish = () => {
    copy.remove();
    releaseExit(list);
  };
  animation.finished.then(finish, finish);
}

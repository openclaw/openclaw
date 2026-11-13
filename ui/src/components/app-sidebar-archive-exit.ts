/** Keep in sync with the `[data-sidebar-archive-exiting]` transitions in layout.css. */
const EXIT_DURATION_MS = 240;
const EXIT_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const SNAPSHOT_ATTRIBUTES = [
  "id",
  "data-session-key",
  "data-session-tree",
  "data-session-window-key",
];
const exitsByList = new WeakMap<HTMLElement, number>();

/**
 * Starts a short exit for a sidebar row the user is archiving; call it right
 * before the optimistic removal and call the returned stop once that settles.
 *
 * The roster still owns membership and removes the live row immediately. When
 * the row's tree leaves the list, an inert snapshot takes its place and fades out
 * while the remaining rows glide into the gap. Archiving the last row of a
 * section unmounts the whole list, so that case stays instant.
 */
export function startSidebarArchiveExit(row: HTMLElement): () => void {
  const tree = row.closest<HTMLElement>(".sidebar-session-tree") ?? row;
  const list = tree.parentElement;
  const view = row.ownerDocument.defaultView;
  // DOM shims without Web Animations (jsdom) keep the instant removal.
  if (
    !list ||
    !view ||
    typeof tree.animate !== "function" ||
    view.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return () => undefined;
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
      insertSnapshot(tree, height, list, removal.nextSibling);
    }
  });
  observer.observe(list, { childList: true });
  // Solid applies the optimistic removal before the next frame; stop afterward.
  return () =>
    view.requestAnimationFrame(() => {
      observer.disconnect();
      if (!removed) {
        releaseExit(list);
      }
    });
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

function insertSnapshot(tree: HTMLElement, height: number, list: HTMLElement, next: Node | null) {
  // SAFETY: a deep clone of an HTMLElement is an HTMLElement of the same type.
  const snapshot = tree.cloneNode(true) as HTMLElement;
  // The snapshot is detached, unowned markup: drop the identities that selectors,
  // focus restoration and the virtual window key on, so nothing mistakes it for the row.
  for (const element of [snapshot, ...snapshot.getElementsByTagName("*")]) {
    for (const name of SNAPSHOT_ATTRIBUTES) {
      element.removeAttribute(name);
    }
  }
  snapshot.dataset.sidebarArchiveExit = "";
  snapshot.inert = true;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.style.overflow = "hidden";
  list.insertBefore(snapshot, next?.parentNode === list ? next : null);
  const fade = { opacity: 0, translate: "-10px 0", scale: "0.98", filter: "blur(1.5px)" };
  const shown = { opacity: 1, translate: "0 0", scale: "1", filter: "blur(0)" };
  // Windowed lists position rows absolutely, so their neighbors glide by
  // transition. In-flow lists need the snapshot itself to give its slot back.
  const keyframes = list.classList.contains("sidebar-session-window")
    ? [shown, fade]
    : [
        { ...shown, height: `${height}px` },
        { ...fade, height: `${height}px`, offset: 0.5 },
        {
          ...fade,
          height: "0px",
          marginBottom: `${-Number.parseFloat(getComputedStyle(list).rowGap) || 0}px`,
        },
      ];
  const finish = () => {
    snapshot.remove();
    releaseExit(list);
  };
  snapshot
    .animate(keyframes, { duration: EXIT_DURATION_MS, easing: EXIT_EASING, fill: "forwards" })
    .finished.then(finish, finish);
}

import { CONTROL_UI_SETTING_ID_ALIASES } from "../../../src/shared/control-ui-settings/index.ts";
import { listen } from "./reactive/listener.ts";
import { resolveScrollBehavior } from "./scroll-behavior.ts";

/** Marks the setting a link brought the reader to. */
const SETTINGS_ARRIVAL_ATTRIBUTE = "data-settings-arrival";
// The mark is inset because a settings group clips overflow. It is drawn inline rather than in
// a stylesheet, which every Settings page would otherwise load for a rare arrival.
const ARRIVAL_BAR = "inset 3px 0 0 color-mix(in srgb, var(--accent) 75%, transparent)";
const ARRIVAL_WASH = "color-mix(in srgb, var(--accent) 11%, transparent)";
const ARRIVAL_STYLES = [
  "box-shadow",
  "outline",
  "background-color",
  "margin-inline",
  "padding-inline",
];

/** Frames a row holds its place before its scroll counts as finished. */
const SETTLED_FRAMES = 4;
/** A scroll that never settles still shows its mark. */
const MAX_SCROLL_FRAMES = 120;

/**
 * The element a settings link names inside `root`. A former setting ID resolves to its
 * current one. A setting that has no row yet, such as a field of an object the config does
 * not define, resolves to the nearest enclosing setting that is rendered.
 */
function findSettingsTarget(root: HTMLElement, targetId: string): HTMLElement | null {
  for (let id = CONTROL_UI_SETTING_ID_ALIASES[targetId] ?? targetId; id;) {
    const target = root.ownerDocument.getElementById(id);
    if (target && root.contains(target)) {
      return target;
    }
    const parent = id.slice(0, Math.max(0, id.lastIndexOf(".")));
    // A single segment is a section key, never a setting ID.
    id = parent.includes(".") ? parent : "";
  }
  return null;
}

/**
 * Holds the target a route named until its page has rendered it. `request` replaces the
 * target, `commit` looks for it after a render, and `dispose` drops it with its mark. A
 * page that redraws the row after a late read gets the mark on the new row, until the
 * reader acts.
 */
export function createPendingSettingsTarget(host: () => HTMLElement) {
  let targetId: string | null = null;
  let frame: number | null = null;
  let leave: (() => void) | undefined;
  let arrived: HTMLElement | undefined;
  const cancel = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    leave?.();
    leave = undefined;
    arrived = undefined;
  };
  return {
    request(id: string | null) {
      cancel();
      targetId = id;
    },
    commit() {
      if (!targetId || frame !== null || arrived?.isConnected) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        // Settings routes share one live page; keep the document's ID lookup scoped to it.
        const target = targetId ? findSettingsTarget(host(), targetId) : null;
        if (!target) {
          return;
        }
        leave?.();
        arrived = target;
        leave = arriveAtSettingsTarget(target, () => {
          targetId = null;
        });
      });
    },
    dispose: cancel,
  };
}

/**
 * Brings the target of a settings link into view. One setting row is centered, marked
 * after the scroll stops, and focused; a larger block keeps its top-aligned scroll.
 * Nothing is edited. Returns the cleanup for a pending or visible mark.
 */
function arriveAtSettingsTarget(target: HTMLElement, onRead: () => void): () => void {
  // A row inside a closed disclosure has no place on screen to scroll to.
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      parent.open = true;
    }
  }
  const behavior = resolveScrollBehavior();
  // A provider is one row too, drawn by its own list markup.
  if (!target.matches(".settings-row, .provider-row")) {
    target.scrollIntoView?.({ behavior, block: "start" });
    return () => {};
  }
  // Centered, the row keeps its neighbors for context and clears any sticky header.
  target.scrollIntoView?.({ behavior, block: "center" });
  const view = target.ownerDocument.defaultView;
  let frame: number | undefined;
  let stopListening: Array<() => void> = [];
  let wash: Animation | undefined;
  const clear = () => {
    target.removeAttribute(SETTINGS_ARRIVAL_ATTRIBUTE);
    wash?.cancel();
    for (const property of ARRIVAL_STYLES) {
      target.style.removeProperty(property);
    }
    for (const stop of stopListening) {
      stop();
    }
    stopListening = [];
  };
  const mark = () => {
    frame = undefined;
    target.setAttribute(SETTINGS_ARRIVAL_ATTRIBUTE, "");
    const style = target.style;
    style.boxShadow = ARRIVAL_BAR;
    style.outline = "none";
    // A row flush with its container, such as in a channel detail, gets room for the bar.
    if (view?.getComputedStyle(target).paddingInlineStart === "0px") {
      style.marginInline = "calc(-1 * var(--space-3))";
      style.paddingInline = "var(--space-3)";
    }
    // The wash fades while the bar stays; without motion the wash stays with the bar.
    if (behavior === "smooth" && target.animate) {
      wash = target.animate(
        [
          { backgroundColor: "transparent" },
          { backgroundColor: ARRIVAL_WASH, offset: 0.12 },
          { backgroundColor: ARRIVAL_WASH, offset: 0.45 },
          { backgroundColor: "transparent" },
        ],
        { duration: 2400, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    } else {
      style.backgroundColor = ARRIVAL_WASH;
    }
    // Focus lands on the row, never inside its control: no key press can change the value.
    // A row that is a control itself, such as a disclosure's summary, already takes focus
    // and names itself.
    if (target.tabIndex < 0) {
      const title = target.ownerDocument.getElementById(`${target.id}-title`);
      if (title && target.contains(title)) {
        target.setAttribute("role", "group");
        target.setAttribute("aria-labelledby", title.id);
      }
      target.tabIndex = -1;
    }
    target.focus({ preventScroll: true });
    // The mark has done its job once the reader acts.
    stopListening = (["pointerdown", "keydown"] as const).map((type) =>
      listen(
        target.ownerDocument,
        type,
        () => {
          clear();
          onRead();
        },
        { capture: true, passive: true },
      ),
    );
  };
  // A fading mark is wasted while the row is still moving, so it waits for the scroll to end.
  let settledFrames = 0;
  let frames = 0;
  let lastTop = Number.NaN;
  const watch = () => {
    const top = target.getBoundingClientRect().top;
    settledFrames = top === lastTop ? settledFrames + 1 : 0;
    lastTop = top;
    frames += 1;
    if (settledFrames >= SETTLED_FRAMES || frames >= MAX_SCROLL_FRAMES || !view) {
      mark();
      return;
    }
    frame = view.requestAnimationFrame(watch);
  };
  watch();
  return () => {
    if (frame !== undefined) {
      view?.cancelAnimationFrame(frame);
      frame = undefined;
    }
    clear();
  };
}

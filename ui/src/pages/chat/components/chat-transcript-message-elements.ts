import { createContext } from "solid-js";
import { observeResize } from "../../../lib/reactive/observers.ts";

type MessageElementRef = (element?: Element) => void;

/** The transcript's bubble refs are shared by navigation, selection and reaction layout. */
export function createTranscriptMessageElements(
  entryRefFor: (key: string) => MessageElementRef | undefined,
) {
  const mounted = new Map<string, HTMLElement>();
  const reactions = new Map<string, { refresh: () => void; release: () => void }>();
  let changed: (() => void) | undefined;
  return {
    get elements(): ReadonlyMap<string, HTMLElement> {
      return mounted;
    },
    observeReactions(key: string, element: HTMLElement): () => void {
      let stop: (() => void) | undefined;
      let targets: Element[] = [];
      const refresh = () => {
        const bubble = mounted.get(key);
        const footer = element.parentElement;
        if (!bubble || !footer) {
          stop?.();
          stop = undefined;
          targets = [];
          return;
        }
        const next =
          footer.classList.contains("chat-group-footer") ||
          footer.classList.contains("chat-message-actions-row")
            ? [bubble, footer, ...footer.children]
            : [bubble, element, footer];
        if (
          next.length !== targets.length ||
          next.some((target, index) => target !== targets[index])
        ) {
          stop?.();
          targets = next;
          stop = observeResize(targets, refresh);
        }
        alignReactions(bubble, element, footer);
      };
      const release = () => {
        stop?.();
        element.parentElement?.classList.remove("chat-footer--reaction-edge");
        element.classList.remove(
          "chat-message-reactions--anchored",
          "chat-message-reactions--add-flipped",
        );
      };
      const entry = { refresh, release };
      reactions.get(key)?.release();
      reactions.set(key, entry);
      const bubble = mounted.get(key);
      if (bubble) {
        stop = observeResize([bubble, element], refresh);
      }
      return () => {
        if (reactions.get(key) !== entry) {
          return;
        }
        release();
        reactions.delete(key);
      };
    },
    forKey(key: string): MessageElementRef {
      let registered: HTMLElement | undefined;
      return (element) => {
        const previous = mounted.get(key);
        const current = element instanceof HTMLElement ? element : undefined;
        // A replacement branch can mount before the previous branch cleans up.
        if (!current && previous !== registered) {
          return;
        }
        registered = current;
        entryRefFor(key)?.(element);
        if (current) {
          mounted.set(key, current);
        } else {
          mounted.delete(key);
        }
        if (previous !== current) {
          reactions.get(key)?.refresh();
          changed?.();
        }
      };
    },
    subscribe(listener: () => void): () => void {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    dispose(): void {
      for (const reaction of reactions.values()) {
        reaction.release();
      }
      reactions.clear();
      mounted.clear();
      changed = undefined;
    },
  };
}

export type TranscriptMessageElements = ReturnType<typeof createTranscriptMessageElements>;

export const TranscriptMessageElementsContext = createContext<TranscriptMessageElements | null>(
  null,
);

/** Reuse the transcript's mounted bubble refs; only the footer's horizontal tracks change. */
function alignReactions(bubble: HTMLElement, row: HTMLElement, footer: HTMLElement): void {
  const own = row.classList.contains("chat-message-reactions--own");
  const footerRow =
    footer.classList.contains("chat-group-footer") ||
    footer.classList.contains("chat-message-actions-row");
  if (footerRow) {
    footer.classList.add("chat-footer--reaction-edge");
  }
  row.classList.add("chat-message-reactions--anchored");
  const bounds = footer.getBoundingClientRect();
  const anchor = bubble.getBoundingClientRect();
  const gap = Number.parseFloat(getComputedStyle(footer).columnGap) || 0;
  const details = (footerRow ? [...footer.children] : []).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child !== row,
  );
  const sizes = details.map((child) =>
    Math.max(child.getBoundingClientRect().width, child.scrollWidth),
  );
  const total =
    sizes.reduce((sum, value) => sum + value, 0) + Math.max(0, details.length - 1) * gap;
  // Wrap visible chips before they displace the reserved footer details.
  const outside = own ? anchor.left - bounds.left : bounds.right - anchor.right;
  const limit =
    outside >= total + gap
      ? anchor.width
      : own
        ? bounds.right - anchor.left - total - gap
        : anchor.right - bounds.left - total - gap;
  row.style.setProperty(
    "--chat-reaction-max-width",
    `${Math.max(0, Math.min(anchor.width, limit))}px`,
  );
  const width = row.getBoundingClientRect().width;
  // A minimum-width row may need its add button on the other side at the viewport edge.
  const desiredLeft = own ? anchor.left - bounds.left : anchor.right - bounds.left - width;
  const viewportWidth = row.ownerDocument.documentElement.clientWidth;
  const rowStyle = getComputedStyle(row);
  const addSpace =
    Number.parseFloat(rowStyle.paddingLeft) + Number.parseFloat(rowStyle.paddingRight);
  const flipped =
    addSpace > 0 &&
    (bounds.left + desiredLeft < 0 || bounds.left + desiredLeft + width > viewportWidth);
  row.classList.toggle("chat-message-reactions--add-flipped", flipped);
  const adjustedLeft = desiredLeft + (flipped ? (own ? -addSpace : addSpace) : 0);
  const left = Math.max(-bounds.left, Math.min(adjustedLeft, viewportWidth - bounds.left - width));
  row.style.setProperty("--chat-footer-item-left", `${left}px`);
  const before = Math.max(0, left - gap);
  const after = Math.max(0, bounds.width - left - width - gap);
  const onLeft = before >= after;
  const available = onLeft ? before : after;
  if (total <= available || details.length < 2) {
    let cursor = onLeft
      ? own
        ? Math.max(0, before - total)
        : 0
      : own
        ? bounds.width - total
        : left + width + gap;
    details.forEach((child, index) => {
      child.style.setProperty("--chat-footer-item-left", `${cursor}px`);
      child.style.setProperty("--chat-footer-item-width", `${available}px`);
      cursor += sizes[index]! + gap;
    });
  } else {
    details.forEach((child, index) => {
      const atStart = index === 0;
      child.style.setProperty("--chat-footer-item-left", `${atStart ? 0 : left + width + gap}px`);
      child.style.setProperty("--chat-footer-item-width", `${atStart ? before : after}px`);
    });
  }
}

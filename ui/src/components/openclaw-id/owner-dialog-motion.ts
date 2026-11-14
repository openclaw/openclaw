import { onSettled } from "solid-js";
import { observeResize } from "../../lib/reactive/observers.ts";

/** Retain only geometry; Solid and the dialog owners still own content and focus. */
export function createOwnerDialogMotion() {
  const heights = new Map<HTMLElement, number | undefined>();
  const moving = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  let card: HTMLElement;
  let finishCollapse: (() => void) | undefined;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clear = (element: HTMLElement) => {
    clearTimeout(moving.get(element));
    moving.delete(element);
    element.style.height = "";
    element.style.overflow = "";
    element.style.transition = "";
  };
  const morph = () => {
    // Clear nested height constraints together before measuring their natural sizes.
    const before = new Map<HTMLElement, number | undefined>();
    for (const [element, height] of heights) {
      if (!element.isConnected) {
        clear(element);
        heights.delete(element);
      } else {
        before.set(element, moving.has(element) ? element.getBoundingClientRect().height : height);
      }
    }
    for (const element of moving.keys()) {
      clear(element);
    }
    for (const element of heights.keys()) {
      heights.set(element, element.getBoundingClientRect().height);
    }
    if (reduced()) {
      return;
    }
    for (const [element, height] of heights) {
      const previous = before.get(element) ?? height;
      if (height === undefined || previous === undefined) {
        continue;
      }
      if (Math.abs(height - previous) < 1) {
        continue;
      }
      element.style.height = `${previous}px`;
      element.style.overflow = "hidden";
    }
    card.getBoundingClientRect();
    for (const [element, height] of heights) {
      if (!element.style.height) {
        continue;
      }
      element.style.transition = "height .28s cubic-bezier(.2,.8,.2,1)";
      element.style.height = `${height}px`;
      moving.set(
        element,
        setTimeout(() => clear(element), 300),
      );
    }
  };
  onSettled(() => {
    for (const element of heights.keys()) {
      heights.set(element, element.getBoundingClientRect().height);
    }
    // Observe committed content; native disclosures keep their existing behavior.
    const observer = new MutationObserver(morph);
    observer.observe(card, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    const stopResize = observeResize([card], () => {
      if (moving.size === 0) {
        for (const element of heights.keys()) {
          heights.set(element, element.getBoundingClientRect().height);
        }
      }
    });
    return () => {
      observer.disconnect();
      stopResize();
      finishCollapse?.();
      for (const element of moving.keys()) {
        clear(element);
      }
    };
  });
  return {
    card: (element: HTMLElement) => {
      card = element;
      heights.set(element, element.getBoundingClientRect().height);
    },
    section: (element: HTMLElement) => {
      heights.set(element, undefined);
    },
    async collapse(rows: HTMLElement[]) {
      if (reduced() || rows.length === 0) {
        return;
      }
      for (const row of rows) {
        const height = row.getBoundingClientRect().height;
        clear(row);
        heights.delete(row);
        row.style.height = `${height}px`;
      }
      card.getBoundingClientRect();
      for (const row of rows) {
        row.classList.add("openclaw-id-devices__row--gone");
        row.style.height = "0px";
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          finishCollapse = undefined;
          resolve();
        }, 280);
        finishCollapse = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      // The list reconciliation now supplies the card's post-collapse height.
      heights.set(card, card.getBoundingClientRect().height);
    },
  };
}

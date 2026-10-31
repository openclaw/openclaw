import { createContext, useContext } from "solid-js";
import { elementRef } from "../lib/reactive/element-ref.ts";

export type HovercardControls = {
  registerSource: (read: () => readonly HTMLElement[]) => () => void;
  read: () => HTMLElement[];
};

const cards = new WeakMap<HTMLElement, HovercardControls>();

/** A card retains its controls across renderer replacement, until their owners retire them. */
export function controlsForHovercard(card: HTMLElement): HovercardControls {
  const existing = cards.get(card);
  if (existing) {
    return existing;
  }
  const sources = new Set<() => readonly HTMLElement[]>();
  const registry: HovercardControls = {
    registerSource(read) {
      sources.add(read);
      return () => sources.delete(read);
    },
    read() {
      const current = new Set([...sources].flatMap((read) => read()));
      return [...current]
        .filter((element) => {
          if (
            !element.isConnected ||
            !card.contains(element) ||
            element.tabIndex < 0 ||
            (element instanceof HTMLButtonElement && element.disabled)
          ) {
            return false;
          }
          // Rich inspection controls join the card's tab order only while revealed.
          const content = element.closest('[slot="content"]');
          return !content?.parentElement?.matches("openclaw-tooltip:not([open])");
        })
        .toSorted((left, right) =>
          left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
    },
  };
  cards.set(card, registry);
  return registry;
}

export const HovercardControlsContext = createContext<HovercardControls | null>(null);

/** Create under the control's owner; the ref itself runs without a Solid owner. */
export function createHovercardControlRef(): (element: HTMLElement) => void {
  const controls = useContext(HovercardControlsContext);
  return elementRef((element: HTMLElement) => controls?.registerSource(() => [element]));
}

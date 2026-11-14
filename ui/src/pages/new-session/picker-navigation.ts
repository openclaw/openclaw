import { createContext, createUniqueId, onSettled, useContext } from "solid-js";
import { isComposingKeyboardEvent } from "../../lib/ime.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";

export const PickerNavigation = createContext<ReturnType<typeof createPickerNavigation> | null>(
  null,
);

/** Search owns focus; the existing row click remains the selection boundary. */
export function createPickerNavigation() {
  const id = createUniqueId();
  const options = new Set<HTMLElement>();
  let nextId = 0;
  let input: HTMLInputElement | undefined;
  let active: HTMLElement | undefined;
  const available = (row: HTMLElement) =>
    !row.matches(':disabled, [aria-disabled="true"]') && row.checkVisibility();
  const highlight = (row?: HTMLElement) => {
    active?.removeAttribute("data-highlighted");
    active = row;
    if (row) {
      row.id ||= `${id}-option-${encodeURIComponent(row.dataset.value ?? `row-${nextId++}`)}`;
      row.setAttribute("data-highlighted", "");
      // The active row remains a button (including Browse), owned by the focused searchbox.
      input?.setAttribute("aria-owns", row.id);
      input?.setAttribute("aria-activedescendant", row.id);
    } else {
      input?.removeAttribute("aria-activedescendant");
      input?.removeAttribute("aria-owns");
    }
  };
  return {
    inputRef(node: HTMLInputElement) {
      input = node;
      highlight();
    },
    clear: () => highlight(),
    register(row: HTMLElement) {
      options.add(row);
    },
    remove(row: HTMLElement) {
      options.delete(row);
      if (active === row) {
        highlight();
      }
    },
    hover(row: HTMLElement) {
      if (available(row)) {
        highlight(row);
      }
    },
    keydown(event: KeyboardEvent) {
      if (
        isComposingKeyboardEvent(event) ||
        (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp")
      ) {
        return false;
      }
      const rows = [...options]
        .filter(available)
        .toSorted((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
      const index = active ? rows.indexOf(active) : -1;
      if (event.key === "Enter" && index >= 0) {
        event.preventDefault();
        active!.click();
        return true;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return false;
      }
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next =
        index < 0
          ? direction === 1
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, index + direction));
      const row = rows[next];
      highlight(row);
      row?.scrollIntoView({ block: "nearest" });
      return true;
    },
  };
}

export function pickerOptionRef() {
  const navigation = useContext(PickerNavigation);
  if (!navigation) {
    return () => {};
  }
  let row: HTMLElement;
  const hover = nativeListener("pointermove", () => navigation.hover(row));
  onSettled(() => () => navigation.remove(row));
  return (node: HTMLElement) => {
    row = node;
    navigation.register(row);
    hover(row);
  };
}

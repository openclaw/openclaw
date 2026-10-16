import { revealInScrollRegion } from "./scroll-state.ts";

export function handleComposerMenuKeydown(
  event: KeyboardEvent,
  menu: {
    count: number;
    index: number;
    consumeEmpty: boolean;
    close: () => void;
    move: (index: number) => string | null;
    select: (key: "Enter" | "Tab") => void;
  },
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    menu.close();
    return true;
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab"].includes(event.key) ||
    (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)) ||
    (menu.count === 0 && !menu.consumeEmpty)
  ) {
    return false;
  }
  event.preventDefault();
  if (menu.count > 0) {
    if (event.key === "Home" || event.key === "End") {
      scrollActiveOptionIntoView(menu.move(event.key === "Home" ? 0 : menu.count - 1));
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : menu.count - 1;
      scrollActiveOptionIntoView(menu.move((menu.index + offset) % menu.count));
    } else if (event.key === "Enter" || event.key === "Tab") {
      menu.select(event.key);
    }
  }
  return true;
}

function scrollActiveOptionIntoView(activeId: string | null): void {
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (activeOption && scrollRegion) {
      revealInScrollRegion(scrollRegion, activeOption);
    }
  });
}

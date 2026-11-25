import type { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";

const DRAGGING_CLASS = "model-providers__profile--dragging";
const SORTING_CLASS = "model-providers__profiles--sorting";

/** Only neighbors between the original and target slots move, by one dragged item's extent. */
export function neighborOffset(index: number, source: number, target: number, extent: number) {
  if (source < index && index <= target) {
    return -extent;
  }
  if (target <= index && index < source) {
    return extent;
  }
  return 0;
}

/** Keep keyboard focus on the moved account, without stealing focus from a new target. */
export function reorderByArrow(
  event: KeyboardEvent,
  order: string[],
  index: number,
  axis: "horizontal" | "vertical",
  move: (target: string) => void,
) {
  const horizontal = axis === "horizontal";
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const leftOrUp = event.key === (horizontal ? "ArrowLeft" : "ArrowUp");
  if (!leftOrUp && event.key !== (horizontal ? "ArrowRight" : "ArrowDown")) {
    return;
  }
  event.preventDefault();
  const rtl = horizontal && getComputedStyle(button).direction === "rtl";
  const target = order[index + (leftOrUp !== rtl ? -1 : 1)];
  if (!target) {
    return;
  }
  const focused = document.activeElement === button;
  move(target);
  if (focused) {
    queueMicrotask(() => {
      if (button.isConnected && document.activeElement === document.body) {
        button.focus({ preventScroll: true });
      }
    });
  }
}

export function startProfileRowDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  row: HTMLElement;
  move: (targetId: string) => void;
  drag: ReturnType<typeof createPointerDrag>;
}): void {
  if (!params.canMove || params.event.button !== 0) {
    return;
  }
  const { row } = params;
  const list = row.parentElement;
  const grip = params.event.currentTarget;
  if (!list || !(grip instanceof HTMLElement)) {
    return;
  }
  const listTop = list.getBoundingClientRect().top;
  // Use the original slots for hit testing. Measuring animated neighbors would
  // make the insertion point oscillate as they move out from under the pointer.
  const slots = Array.from(list.children)
    .filter(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        candidate.dataset.profileProvider === row.dataset.profileProvider,
    )
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }));
  const source = slots.findIndex((slot) => slot.element === row);
  const sourceBounds = slots[source]!.bounds;
  const neighbors = slots.filter((_, index) => index !== source);
  let target = source;
  params.event.preventDefault();
  list.classList.add(SORTING_CLASS);
  row.classList.add(DRAGGING_CLASS);
  const update = (event: PointerEvent) => {
    const scrollOffset = listTop - list.getBoundingClientRect().top;
    const deltaY = event.clientY - params.event.clientY + scrollOffset;
    row.style.translate = `${event.clientX - params.event.clientX}px ${deltaY}px`;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const pointerY = event.clientY + scrollOffset;
    const inside =
      (hit === list || slots.some(({ element }) => element.contains(hit))) &&
      slots.some(
        ({ bounds }) =>
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          pointerY >= bounds.top &&
          pointerY <= bounds.bottom,
      );
    // Swap as the leading edge crosses a neighbor's center, without requiring
    // the dragged row to travel a full slot before the neighbor makes room.
    const leadingY = (deltaY > 0 ? sourceBounds.bottom : sourceBounds.top) + deltaY;
    target = inside
      ? neighbors.findIndex(({ bounds }) => leadingY < bounds.top + bounds.height / 2)
      : source;
    if (target === -1) {
      target = neighbors.length;
    }
    for (const [index, slot] of slots.entries()) {
      if (index !== source) {
        slot.element.style.translate = `0px ${neighborOffset(index, source, target, sourceBounds.height)}px`;
      }
    }
  };
  const cleanup = () => {
    list.classList.remove(SORTING_CLASS);
    row.classList.remove(DRAGGING_CLASS);
    for (const { element } of slots) {
      element.style.removeProperty("translate");
    }
  };
  const finish = (event: PointerEvent) => {
    update(event);
    cleanup();
    if (target !== source) {
      params.move(slots[target]!.element.dataset.profileId!);
    }
  };
  if (!params.drag.start(params.event, grip, { move: update, end: finish, cancel: cleanup })) {
    cleanup();
  }
}

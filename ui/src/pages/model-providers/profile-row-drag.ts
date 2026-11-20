import { moveArrayEntry, type ArrayDropPosition } from "../../lib/array-order.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";

const DRAGGING_CLASS = "model-providers__profile--dragging";
const SORTING_CLASS = "model-providers__profiles--sorting";

export function startProfileRowDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  provider: string;
  row: HTMLElement;
  section: HTMLElement;
  rows: HTMLElement[];
  move: (targetId: string, position: ArrayDropPosition) => void;
  drag: ReturnType<typeof createPointerDrag>;
}): void {
  if (!params.canMove || params.event.button !== 0) {
    return;
  }
  const grip = params.event.currentTarget;
  if (!(grip instanceof HTMLElement)) {
    return;
  }
  const { row, section } = params;
  const sectionTop = section.getBoundingClientRect().top;
  // Use the original slots for hit testing. Measuring animated neighbors would
  // make the insertion point oscillate as they move out from under the pointer.
  const slots = params.rows
    .filter((candidate) => candidate.dataset.profileProvider === params.provider)
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }));
  const source = slots.find((slot) => slot.element === row);
  if (!source) {
    return;
  }
  const others = slots.filter((slot) => slot !== source);
  let target: (typeof slots)[number] | undefined;
  let position: ArrayDropPosition = "before";
  params.event.preventDefault();
  section.classList.add(SORTING_CLASS);
  row.classList.add(DRAGGING_CLASS);
  const update = (event: PointerEvent) => {
    const scrollOffset = sectionTop - section.getBoundingClientRect().top;
    const deltaY = event.clientY - params.event.clientY + scrollOffset;
    row.style.translate = `${event.clientX - params.event.clientX}px ${deltaY}px`;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const hitRow = hit?.closest<HTMLElement>(".model-providers__profile");
    const pointerY = event.clientY + scrollOffset;
    const inside =
      hit &&
      section.contains(hit) &&
      (!hitRow || hitRow.dataset.profileProvider === params.provider) &&
      slots.some(
        ({ bounds }) =>
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          pointerY >= bounds.top &&
          pointerY <= bounds.bottom,
      );
    // Swap as the leading edge crosses a neighbor's center, without requiring
    // the dragged row to travel a full slot before the neighbor makes room.
    const leadingY = (deltaY > 0 ? source.bounds.bottom : source.bounds.top) + deltaY;
    target = inside
      ? others.find(({ bounds }) => leadingY < bounds.top + bounds.height / 2)
      : undefined;
    position = target ? "before" : "after";
    if (inside && !target) {
      target = others.at(-1);
    }
    const preview = target ? moveArrayEntry(slots, source, target, position) : slots;
    if (preview.indexOf(source) === slots.indexOf(source)) {
      target = undefined;
    }
    let top = slots[0]?.bounds.top ?? 0;
    for (const slot of preview) {
      if (slot !== source) {
        slot.element.style.translate = `0px ${top - slot.bounds.top}px`;
      }
      top += slot.bounds.height;
    }
  };
  const cleanup = () => {
    stopKeydown();
    section.classList.remove(SORTING_CLASS);
    for (const { element } of slots) {
      element.classList.remove(DRAGGING_CLASS);
      element.style.removeProperty("translate");
    }
  };
  const finish = (event: PointerEvent) => {
    update(event);
    const targetId = target?.element.dataset.profileId;
    cleanup();
    if (targetId) {
      params.move(targetId, position);
    }
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      params.drag.cancel();
    }
  };
  // A drag owns Escape before the Settings shell handles its back shortcut.
  const stopKeydown = listen(document, "keydown", { handleEvent: handleKeyDown }, true);
  if (!params.drag.start(params.event, grip, { move: update, end: finish, cancel: cleanup })) {
    cleanup();
  }
}

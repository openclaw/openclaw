import type { Overlay } from "../overlay-lifecycle.ts";
import type { MenuNavigationOptions, MenuRuntime } from "./menu-runtime.ts";

export type PendingMenuHover = {
  event: PointerEvent;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
};

export type PendingMenuIntent =
  | { run: (loaded: MenuRuntime) => void; highlightedValue?: string | null; keyboard?: never }
  | {
      keyboard: KeyboardEvent;
      target: "content" | "input" | "trigger";
      originalTarget: HTMLElement;
      currentTarget: EventTarget | null;
      highlightedValue?: never;
    };

/** Only the loaded navigation runtime can replay input admitted by the cold menu. */
export async function replayMenuIntents(
  loaded: MenuRuntime,
  parentRuntime: () => MenuRuntime | undefined,
  pending: PendingMenuIntent[],
  hover: PendingMenuHover | undefined,
  overlay: Overlay,
  items: () => HTMLElement[],
  surface: MenuNavigationOptions["surface"],
  ready: () => void,
) {
  if (hover && overlay.trigger?.matches(":hover") && overlay.parent?.open) {
    const replay = new PointerEvent(hover.event.type, hover.event);
    Object.defineProperties(replay, {
      target: { value: hover.target },
      currentTarget: { value: hover.currentTarget },
    });
    loaded.trigger(parentRuntime()).onPointerMove(replay);
  }
  // Adopt the row focused by native entry before replaying later input.
  if (overlay.open && surface !== "listbox") {
    const focused = items().find((item) => item.matches(":focus"));
    if (focused?.dataset.value) {
      loaded.read().setHighlightedValue(focused.dataset.value);
    }
  }
  ready();
  for (let intent = pending.shift(); intent; intent = pending.shift()) {
    if (intent.keyboard) {
      const { keyboard, target, originalTarget, currentTarget } = intent;
      const replay = new KeyboardEvent(keyboard.type, keyboard);
      Object.defineProperties(replay, {
        target: {
          value: target === "content" ? loaded.service.scope.getActiveElement() : originalTarget,
        },
        currentTarget: { value: currentTarget },
      });
      if (target === "content") {
        loaded.content().onKeyDown(replay);
      } else if (target === "trigger") {
        loaded.trigger(parentRuntime()).onKeyDown(replay);
      } else {
        loaded.keydown(replay);
      }
    } else {
      intent.run(loaded);
    }
    // Vanilla queues the transition; Home/End queue the highlight again. Drain both before replay.
    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
  }
}

import type { Overlay } from "../overlay-lifecycle.ts";
import type { MenuNavigationOptions, MenuRuntime } from "./menu-runtime.ts";

export { createMenuRuntime } from "./menu-runtime.ts";

export type MenuKeySource = "content" | "input" | "trigger";

type CapturedMenuEvent<E extends Event> = {
  event: E;
  originalTarget: EventTarget | null;
  currentTarget: EventTarget | null;
};

export type PendingMenuHover = CapturedMenuEvent<PointerEvent>;

export type PendingMenuIntent =
  | {
      run(runtime: MenuRuntime): void;
      highlightedValue?: string | null;
    }
  | (CapturedMenuEvent<KeyboardEvent> & {
      source: MenuKeySource;
      highlightedValue?: never;
    });

function restoreTargets<E extends Event>(
  event: E,
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): E {
  return Object.defineProperties(event, {
    target: { value: target },
    currentTarget: { value: currentTarget },
  });
}

export function adoptNativeMenuInput(
  runtime: MenuRuntime,
  overlay: Overlay,
  surface: MenuNavigationOptions["surface"],
  items: () => HTMLElement[],
  hover: PendingMenuHover | undefined,
  parentRuntime: () => MenuRuntime | undefined,
): void {
  if (hover && overlay.trigger?.matches(":hover") && overlay.parent?.open) {
    const event = new PointerEvent(hover.event.type, hover.event);
    runtime
      .trigger(parentRuntime())
      .onPointerMove(restoreTargets(event, hover.originalTarget, hover.currentTarget));
  }
  // Native entry already chose focus. Adopt it before replaying subsequent keys.
  if (overlay.open && surface !== "listbox") {
    const value = items().find((item) => item.matches(":focus"))?.dataset.value;
    if (value) {
      runtime.read().setHighlightedValue(value);
    }
  }
}

export async function replayMenuIntents(
  pending: PendingMenuIntent[],
  runtime: MenuRuntime,
  parentRuntime: () => MenuRuntime | undefined,
): Promise<void> {
  let intent: PendingMenuIntent | undefined;
  while ((intent = pending.shift())) {
    if ("run" in intent) {
      intent.run(runtime);
    } else {
      const { event, source, originalTarget, currentTarget } = intent;
      const replay = restoreTargets(
        new KeyboardEvent(event.type, event),
        source === "content" ? runtime.service.scope.getActiveElement() : originalTarget,
        currentTarget,
      );
      if (source === "content") {
        runtime.content().onKeyDown(replay);
      } else if (source === "trigger") {
        runtime.trigger(parentRuntime()).onKeyDown(replay);
      } else {
        runtime.keydown(replay);
      }
    }
    // Zag queues the transition and then the focus update. Let both settle before the next intent.
    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
  }
}

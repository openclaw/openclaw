import { createEffect, onCleanup } from "solid-js";

export function useStreamAutoFollow(options: {
  container: () => HTMLElement | undefined;
  enabled: () => boolean;
  identity: () => unknown;
  content?: () => unknown;
}) {
  let atBottom = true;
  let frame: number | undefined;
  onCleanup(() => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
  });
  const follow = {
    reset() {
      atBottom = true;
    },
    schedule(force = false) {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      const identity = options.identity();
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const container = options.container();
        if (!container?.isConnected || options.identity() !== identity) {
          return;
        }
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (!force && (!options.enabled() || (!atBottom && distance >= 120))) {
          return;
        }
        container.scrollTop = container.scrollHeight;
        atBottom = true;
      });
    },
    handleScroll: (event: Event) => {
      const container = event.currentTarget;
      if (container instanceof HTMLElement) {
        atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      }
    },
  };
  if (options.content) {
    createEffect(
      () => [options.content?.(), options.identity()],
      ([, identity], previous) => follow.schedule(identity !== previous?.[1]),
    );
  }
  return follow;
}

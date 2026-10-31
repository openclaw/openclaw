import { createEffect, onCleanup } from "solid-js";

const FOLLOW_SLACK_PX = 120;

/** Whether the reader is still within reach of the end of a scrolling stream. */
export function isNearStreamEnd(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_SLACK_PX;
}

export function useStreamAutoFollow(options: {
  container: () => HTMLElement | undefined;
  enabled: () => boolean;
  identity: () => unknown;
  content?: () => unknown;
  /** Virtualized streams own convergence as estimated row heights settle. */
  scrollToEnd?: () => void;
}) {
  let atBottom = true;
  let frame: number | undefined;
  onCleanup(() => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
  });
  function schedule(identity: unknown, force = false) {
    // A virtualized trim can emit an anchor scroll before this frame runs.
    const wasAtBottom = atBottom;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const container = options.container();
      if (!container?.isConnected || options.identity() !== identity) {
        return;
      }
      if (!force && (!options.enabled() || (!wasAtBottom && !isNearStreamEnd(container)))) {
        return;
      }
      if (options.scrollToEnd) {
        options.scrollToEnd();
      } else {
        container.scrollTop = container.scrollHeight;
      }
      atBottom = true;
    });
  }
  const follow = {
    reset() {
      atBottom = true;
    },
    schedule(force = false) {
      schedule(options.identity(), force);
    },
    handleScroll: (event: Event) => {
      const container = event.currentTarget;
      if (container instanceof HTMLElement) {
        atBottom = isNearStreamEnd(container);
      }
    },
  };
  if (options.content) {
    createEffect(
      () => [options.content?.(), options.identity()],
      ([, identity], previous) => schedule(identity, identity !== previous?.[1]),
    );
  }
  return follow;
}

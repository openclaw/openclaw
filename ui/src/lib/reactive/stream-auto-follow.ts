import { createEffect, onCleanup } from "solid-js";

export function useStreamAutoFollow(options: {
  container: () => HTMLElement | undefined;
  enabled: () => boolean;
  identity: () => unknown;
  content?: () => unknown;
  /** Virtualized streams own convergence as estimated row heights settle. */
  scrollToEnd?: () => void;
}) {
  let atBottom = true;
  let frame: { id: number; atBottom: boolean } | undefined;
  onCleanup(() => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame.id);
    }
  });
  function schedule(identity: unknown, force = false) {
    // Preserve admitted following across coalesced updates and native anchor scrolls.
    const wasAtBottom = atBottom || frame?.atBottom === true;
    if (frame !== undefined) {
      cancelAnimationFrame(frame.id);
    }
    const id = requestAnimationFrame(() => {
      frame = undefined;
      const container = options.container();
      if (!container?.isConnected || options.identity() !== identity) {
        return;
      }
      if (
        !force &&
        (!options.enabled() ||
          (!wasAtBottom &&
            container.scrollHeight - container.scrollTop - container.clientHeight >= 120))
      ) {
        return;
      }
      if (options.scrollToEnd) {
        options.scrollToEnd();
      } else {
        container.scrollTop = container.scrollHeight;
      }
      atBottom = true;
    });
    frame = { id, atBottom: wasAtBottom };
  }
  const follow = {
    reset() {
      atBottom = true;
    },
    schedule(force = false) {
      schedule(options.identity(), force);
    },
    handleScroll: () => {
      const container = options.container();
      if (container) {
        atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
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

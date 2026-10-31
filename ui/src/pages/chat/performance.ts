import type { RenderLifecycle } from "./render-lifecycle.ts";

export function scheduleControlUiAfterPaint(
  host: { renderLifecycle: Pick<RenderLifecycle, "afterCommit"> },
  callback: () => void,
): void {
  host.renderLifecycle.afterCommit((complete) => {
    let active = true;
    let frame: number | null = null;
    const run = () => {
      if (!active) {
        return;
      }
      active = false;
      try {
        callback();
      } finally {
        complete();
      }
    };
    // Paint timing requires the supported browser primitives, not a microtask approximation.
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!active) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        run();
      });
    });
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
  });
}

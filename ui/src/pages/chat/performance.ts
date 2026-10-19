import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatPerformanceHost = {
  renderLifecycle?: Pick<RenderLifecycle, "afterCommit">;
};

export function controlUiNowMs(): number {
  return performance.now();
}

function runAfterPaint(callback: () => void, complete: () => void): () => void {
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
}

export function scheduleControlUiAfterPaint(
  host: Pick<ChatPerformanceHost, "renderLifecycle">,
  callback: () => void,
): void {
  if (host.renderLifecycle) {
    host.renderLifecycle.afterCommit((complete) => runAfterPaint(callback, complete));
    return;
  }
  // Renderer-free unit hosts have no DOM commit to await.
  runAfterPaint(callback, () => undefined);
}

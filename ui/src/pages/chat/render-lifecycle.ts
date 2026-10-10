type CancelAfterCommit = () => void;
export type AfterCommitEffect = (complete: () => void) => CancelAfterCommit | void;

/**
 * Renderer-neutral boundary for state invalidation and DOM-dependent effects.
 * `afterCommit` must request a render before waiting for its commit.
 */
export interface RenderLifecycle {
  invalidate(): void;
  /**
   * Run after the next commit. Async follow-up work returns its cleanup and
   * calls `complete` when done so the lifecycle owns it through teardown.
   */
  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): CancelAfterCommit;
}

// Opt-in E2E instrumentation. Renderers report accepted invalidations and
// completed DOM commits here; counters and retained references belong to the test.
export function notifyRenderLifecycleForTest(host: object, phase: "invalidate" | "commit"): void {
  // SAFETY: The E2E probe installs this optional property using the shared hook type.
  const scope = globalThis as typeof globalThis & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  };
  scope.openclawRenderLifecycleTestHook?.(host, phase);
}

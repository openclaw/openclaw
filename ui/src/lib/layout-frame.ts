type LayoutRead = () => (() => void) | void;

const pending = new Map<object, LayoutRead>();
let frame = 0;

// One owner's failure must not drop the other owners' work for this frame:
// nothing re-queues it, so a dropped transcript reveal stays a skeleton.
function runIsolated<T>(callback: () => T): T | undefined {
  try {
    return callback();
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/** Read every owner's geometry before publishing any layout-changing state. */
function flushLayout(): void {
  frame = 0;
  const reads = [...pending.values()];
  pending.clear();
  const writes = reads.map((measure) => runIsolated(measure));
  for (const write of writes) {
    if (write) {
      runIsolated(write);
    }
  }
}

export function scheduleLayout(owner: object, read: LayoutRead): void {
  pending.set(owner, read);
  frame ||= requestAnimationFrame(flushLayout);
}

export function cancelLayout(owner: object): void {
  pending.delete(owner);
  if (frame && pending.size === 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/** Resume after a render frame, without a timer fallback's background throttling. */
export function yieldAfterLayout(owner?: object): Promise<void> | undefined {
  // SAFETY: The native scheduler capability is checked before calling it below.
  const scheduler = (window as Window & { scheduler?: { yield(): Promise<void> } }).scheduler;
  // This split wins in Chromium; Firefox's native queue delays first readiness.
  if (document.hidden || !("chrome" in window) || !scheduler?.yield) {
    return undefined;
  }
  return new Promise<void>((resolve) => {
    scheduleLayout(owner ?? resolve, () => resolve(scheduler.yield()));
  });
}

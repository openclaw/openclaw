type LayoutRead = () => (() => void) | void;

const pending = new Map<object, LayoutRead>();
let frame = 0;

/** Read every owner's geometry before publishing any layout-changing state. */
function flushLayout(): void {
  frame = 0;
  const reads = [...pending.values()];
  pending.clear();
  const writes = reads.map((measure) => measure());
  for (const write of writes) {
    if (write) {
      write();
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
  const browser = globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  };
  const yieldTask = browser.scheduler?.yield?.bind(browser.scheduler);
  // This split wins in Chromium; Firefox's native queue delays first readiness.
  if (document.hidden || !("chrome" in browser) || !yieldTask) {
    return undefined;
  }
  return new Promise<void>((resolve) =>
    scheduleLayout(owner ?? resolve, () => () => resolve(yieldTask())),
  );
}

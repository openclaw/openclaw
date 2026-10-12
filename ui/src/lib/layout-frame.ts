type LayoutRead = () => (() => void) | void;

const pending = new Map<object, LayoutRead>();
let frame = 0;
let observer: ResizeObserver | undefined;

function flush(): void {
  observer?.disconnect();
  const reads = [...pending.values()];
  pending.clear();
  const writes = reads.map((measure) => measure());
  for (const write of writes) {
    if (write) {
      write();
    }
  }
}

/** Read every owner's geometry before publishing any layout-changing state. */
export function scheduleLayout(owner: object, read: LayoutRead): void {
  pending.set(owner, read);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    // A new observation is delivered after this frame's style/layout, even
    // when the root size is unchanged. rAF itself runs before layout.
    observer ??= new ResizeObserver(flush);
    observer.observe(document.documentElement);
  });
}

export function cancelLayout(owner: object): void {
  pending.delete(owner);
  if (frame && pending.size === 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  if (pending.size === 0) {
    observer?.disconnect();
    observer = undefined;
  }
}

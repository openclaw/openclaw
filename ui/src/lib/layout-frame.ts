type LayoutRead = () => (() => void) | void;

const pending = new Map<object, LayoutRead>();
let frame = 0;

/** Read every owner's geometry before publishing any layout-changing state. */
export function scheduleLayout(owner: object, read: LayoutRead): void {
  pending.set(owner, read);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const reads = [...pending.values()];
    pending.clear();
    const writes = reads.map((measure) => measure());
    for (const write of writes) {
      if (write) {
        write();
      }
    }
  });
}

export function cancelLayout(owner: object): void {
  pending.delete(owner);
  if (frame && pending.size === 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

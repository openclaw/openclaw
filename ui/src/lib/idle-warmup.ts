type Warmup = () => Promise<unknown>;

const pending = new Set<Warmup>();

/**
 * First-use surfaces such as menu bodies register their lazy loaders here, so
 * opening them after the page settles skips the loading fallback. Registration
 * never loads code or schedules work; the shell idle owner drains the set on its
 * own schedule, including registrations made by bodies it just loaded.
 */
export function warmWhenIdle(...loads: Warmup[]): void {
  loads.forEach((load) => pending.add(load));
}

export function hasIdleWarmups(): boolean {
  return pending.size > 0;
}

/** Shell idle owner only: claims a bounded batch of registered loaders. */
export function takeIdleWarmups(limit = pending.size): Warmup[] {
  const loads: Warmup[] = [];
  for (const load of pending) {
    if (loads.length >= limit) {
      break;
    }
    pending.delete(load);
    loads.push(load);
  }
  return loads;
}

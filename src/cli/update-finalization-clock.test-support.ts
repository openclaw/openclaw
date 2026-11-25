// Data-module exports stay available to the executable fixture's import hooks after bundling.
export const finalizationFixtureClockUrl = `data:text/javascript,${encodeURIComponent(`
import { mock } from 'node:test';
const realSetTimeout = globalThis.setTimeout;
const realWallNow = Date.now;
const realMonotonicNow = performance.now.bind(performance);
let elapsed = 0;
let frozenMonotonic;
Object.defineProperty(performance, 'now', { value: () => frozenMonotonic ?? realMonotonicNow() + elapsed, configurable: true });
export function startFinalizationFixtureClock(freezeMonotonic = false) {
  if (freezeMonotonic) frozenMonotonic = realMonotonicNow() + elapsed;
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
}
export function restoreFinalizationFixtureClock() {
  if (frozenMonotonic !== undefined) {
    elapsed = frozenMonotonic - realMonotonicNow();
    frozenMonotonic = undefined;
  }
  mock.timers.reset();
  Date.now = realWallNow;
}
export function advanceFinalizationFixtureClock(ms) {
  // Resume real cleanup time from the deadline, excluding fixture admission time.
  elapsed = frozenMonotonic === undefined ? elapsed + ms : frozenMonotonic + ms - realMonotonicNow();
  frozenMonotonic = undefined;
  const advancedAt = Date.now() + ms;
  // Cancellation must schedule native process settlement on real time, not this clock.
  globalThis.setTimeout = realSetTimeout;
  try { mock.timers.tick(ms); }
  finally {
    mock.timers.reset();
    // Keep the operation clock at the deadline until its real cleanup joins.
    Date.now = () => advancedAt;
  }
}
`)}`;

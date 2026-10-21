// Data-module exports stay available to the executable fixture's import hooks after bundling.
export const finalizationFixtureClockUrl = `data:text/javascript,${encodeURIComponent(`
import { mock } from 'node:test';
const realSetTimeout = globalThis.setTimeout;
const realWallNow = Date.now;
const realMonotonicNow = performance.now.bind(performance);
let elapsed = 0;
Object.defineProperty(performance, 'now', { value: () => realMonotonicNow() + elapsed, configurable: true });
export function startFinalizationFixtureClock() {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
}
export function restoreFinalizationFixtureClock() {
  mock.timers.reset();
  Date.now = realWallNow;
}
export function advanceFinalizationFixtureClock(ms) {
  elapsed += ms;
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

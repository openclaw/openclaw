/**
 * Wait for the event loop to become responsive before starting network I/O.
 *
 * Large ESM modules (e.g. auth-profiles with bundled AJV schema compilation)
 * can trigger deferred synchronous evaluation that blocks the event loop for
 * several seconds *after* the top-level import promise resolves.  Any WebSocket
 * or HTTP connection opened during this window will time out because socket
 * data callbacks cannot fire until the blocking work finishes.
 *
 * This helper schedules short timers and watches for abnormal drift.  It
 * resolves only after two consecutive on-time callbacks, guaranteeing that any
 * deferred module-evaluation work has completed.  On systems without the
 * blocking issue this adds only ~40 ms of overhead.
 */
export function waitForEventLoopReady(): Promise<void> {
  return new Promise<void>((resolve) => {
    let consecutiveOk = 0;
    let prev = Date.now();
    const check = () => {
      const now = Date.now();
      const drift = now - prev;
      prev = now;
      if (drift > 200) {
        // Timer fired way later than expected — event loop was starved.
        consecutiveOk = 0;
      } else {
        consecutiveOk++;
      }
      if (consecutiveOk >= 2) {
        resolve();
      } else {
        setTimeout(check, 20);
      }
    };
    setTimeout(check, 20);
  });
}

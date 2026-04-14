/**
 * Flush stdout and stderr before exiting.
 *
 * process.exit() called while stdout is piped can truncate buffered output
 * because Node.js does not drain the write buffer on forced termination.
 * We wait for both streams to drain (or 500 ms safety timeout), then call
 * process.exit(). The safety timer is unref()'d so it never prevents exit
 * if the event loop would otherwise be empty.
 */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  const safetyTimer = setTimeout(() => process.exit(code), 500);
  if (typeof safetyTimer.unref === "function") safetyTimer.unref();
  if (process.stdout.writableNeedDrain) {
    process.stdout.once("drain", done);
  } else {
    done();
  }
  if (process.stderr.writableNeedDrain) {
    process.stderr.once("drain", done);
  } else {
    done();
  }
}

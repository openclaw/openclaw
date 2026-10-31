/** Browser init policy for ready-route capture, including authenticated reload. */
export function deferControlUiBootSpeculation(): void {
  const requestIdle = globalThis.requestIdleCallback.bind(globalThis);
  // Timeoutless speculation must not become an eager route preload. Deadline
  // readers/persistence and native handles/cancellation retain their real behavior.
  globalThis.requestIdleCallback = (callback, options) =>
    requestIdle(options?.timeout === undefined ? () => undefined : callback, options);
}

/** Invoke immediately without letting observer failures interrupt delivery bookkeeping. */
export function invokeReplyDispatcherObserver(observer: () => unknown): void {
  try {
    void Promise.resolve(observer()).catch(() => undefined);
  } catch {
    // Error reporting itself can throw synchronously, before returning a promise.
  }
}

/** Return teardown to the caller's effect, onSettled callback, or explicit lifetime. */
export function listen(target: EventTarget, ...args: Parameters<EventTarget["addEventListener"]>) {
  target.addEventListener(...args);
  return () => target.removeEventListener(...args);
}

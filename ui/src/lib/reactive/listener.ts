export function listen(target: EventTarget, ...args: Parameters<EventTarget["addEventListener"]>) {
  target.addEventListener(...args);
  return () => target.removeEventListener(...args);
}

export function defineCachedValue<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  create: () => unknown,
): void {
  let cached: unknown;
  let ready = false;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      if (!ready) {
        cached = create();
        ready = true;
      }
      return cached;
    },
  });
}

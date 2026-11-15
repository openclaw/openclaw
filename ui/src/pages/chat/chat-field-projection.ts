import { createSignal, getObserver, type Signal } from "@solidjs/signals";

/**
 * Track pane-owned fields without changing their synchronous read/write contract.
 * The signal publishes each field's value; the owner remains authoritative between flushes.
 * Accessors retain their own ownership and publication rules.
 */
export function projectChatFields<T extends object>(owner: T, keys?: readonly (keyof T)[]): T;
export function projectChatFields(
  owner: object,
  keys: readonly PropertyKey[] = Object.keys(owner),
): object {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor?.configurable || !descriptor.writable || !("value" in descriptor)) {
      continue;
    }
    let value: unknown = descriptor.value;
    let publication: Signal<{ value: unknown }> | undefined;
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        if (getObserver()) {
          // Unobserved pane features need neither signals nor queued publications.
          // Wrapping the value keeps callbacks from becoming signal derivations.
          publication ??= createSignal({ value }, { ownedWrite: true });
          publication[0]();
        }
        return value;
      },
      set(next: unknown) {
        if (Object.is(value, next)) {
          return;
        }
        value = next;
        publication?.[1]({ value });
      },
    });
  }
  return owner;
}

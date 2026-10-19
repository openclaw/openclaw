import { createSignal, getObserver } from "@solidjs/signals";

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
    // Wrapping the value keeps callback fields from becoming signal derivations.
    const [published, publish] = createSignal({ value }, { ownedWrite: true });
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        if (getObserver()) {
          published();
        }
        return value;
      },
      set(next: unknown) {
        if (Object.is(value, next)) {
          return;
        }
        value = next;
        publish({ value });
      },
    });
  }
  return owner;
}

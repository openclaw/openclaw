const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Reject object keys that can mutate prototypes during config/manifest merges. */
export function isBlockedObjectKey(key: string): boolean {
  return BLOCKED_OBJECT_KEYS.has(key);
}

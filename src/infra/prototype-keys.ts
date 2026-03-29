const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isBlockedObjectKey(key: string): boolean {
  return BLOCKED_OBJECT_KEYS.has(key);
}

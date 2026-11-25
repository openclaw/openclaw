import { getSecretRedactionRegistryRevision } from "./secret-redaction-registry.js";

/** Repeated schemas share field checks only within one support capture. */
export function createSupportKeyChecker(redact: (key: string) => string) {
  const captures = new WeakMap<object, { revision: number; keys: Set<string> }>();
  return (key: string, context: object): boolean => {
    // Exact secrets registered later must mask formerly ordinary field names.
    const revision = getSecretRedactionRegistryRevision();
    let checked = captures.get(context);
    if (checked?.revision !== revision) {
      checked = { revision, keys: new Set() };
      captures.set(context, checked);
    }
    if (checked.keys.has(key)) {
      return true;
    }
    if (redact(key) !== key) {
      return false;
    }
    if (checked.keys.size < 1000) {
      checked.keys.add(key);
    }
    return true;
  };
}

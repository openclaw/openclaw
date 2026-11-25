/**
 * Config merge/patch uses the object tag, not prototype identity: class instances
 * and custom prototypes remain accepted, while Date/Map/Set values are excluded.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

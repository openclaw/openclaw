export type PluginJsonPrimitive = string | number | boolean | null;
export type PluginJsonValue =
  | PluginJsonPrimitive
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export function isPluginJsonValue(value: unknown): value is PluginJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isPluginJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isPluginJsonValue);
}

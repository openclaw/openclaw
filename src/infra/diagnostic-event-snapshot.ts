export function createDiagnosticMetadataForListener<T extends object>(metadata: T): Readonly<T> {
  return Object.freeze({ ...metadata });
}

export function cloneDiagnosticValueForListener<T extends object>(value: T): T {
  return deepFreezeDiagnosticValue(structuredClone(value));
}

export function deepFreezeDiagnosticValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    deepFreezeDiagnosticValue(nested, seen);
  }
  return Object.freeze(value);
}

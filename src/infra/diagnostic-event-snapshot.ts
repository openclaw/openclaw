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
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeDiagnosticValue(item, seen);
    }
    return Object.freeze(value);
  }
  for (const nested of Object.values(value)) {
    deepFreezeDiagnosticValue(nested, seen);
  }
  return Object.freeze(value);
}

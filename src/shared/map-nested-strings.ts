export function mapNestedStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapNestedStrings(entry, transform));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapNestedStrings(entry, transform)]),
  );
}

export function coerceIdentityValue(value, maxLength) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return undefined;
  }
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength) || maxLength <= 0) {
    return trimmed;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function coerceIdentityValue(value, maxLength) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return undefined;
  }
  if (maxLength === 0) {
    return "";
  }
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) {
    return trimmed;
  }
  if (maxLength < 0) {
    return trimmed.slice(0, maxLength);
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

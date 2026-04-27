const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|credential|cookie|authorization|bearer|refresh)/iu;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b[xb]ox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/gu,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{24,}\b/gu,
];

export function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactSecretText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

export function redactEnvValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (shouldRedactKey(key)) {
    return "[redacted]";
  }
  return redactSecretText(value);
}

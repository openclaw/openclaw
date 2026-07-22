const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
]);

const SENSITIVE_HEADER_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "session",
];

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_HEADER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redactHeaders<T extends Record<string, unknown>>(headers: T): T {
  const result = {} as Record<string, unknown>;
  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveHeaderName(name) ? REDACTED_VALUE : value;
  }
  return result as T;
}

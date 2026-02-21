export type InlineToolSecretViolation = {
  key: string;
  path: string;
};

const SENSITIVE_KEY_NAMES = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apitoken",
  "authtoken",
  "bearertoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
]);

// These keys represent opaque resource identifiers, not credentials.
const NON_SECRET_TOKEN_KEYS = new Set([
  "filetoken",
  "foldertoken",
  "doctoken",
  "nodetoken",
  "parentnodetoken",
  "targetparenttoken",
  "nextpagetoken",
  "pagetoken",
  "cursor",
]);

function normalizeKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldInspectKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return false;
  }
  if (NON_SECRET_TOKEN_KEYS.has(normalized)) {
    return false;
  }
  if (SENSITIVE_KEY_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.endsWith("token")
  );
}

function findViolationInValue(
  value: unknown,
  path: string[],
  seen: WeakSet<object>,
): InlineToolSecretViolation | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = findViolationInValue(value[i], [...path, `[${i}]`], seen);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim() && shouldInspectKey(key)) {
      const fullPath = path.length > 0 ? `${path.join(".")}.${key}` : key;
      return { key, path: fullPath };
    }
    const nested = findViolationInValue(raw, [...path, key], seen);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function findInlineToolSecretViolation(params: unknown): InlineToolSecretViolation | null {
  if (process.env.OPENCLAW_ALLOW_INLINE_TOOL_SECRETS === "1") {
    return null;
  }
  return findViolationInValue(params, [], new WeakSet<object>());
}

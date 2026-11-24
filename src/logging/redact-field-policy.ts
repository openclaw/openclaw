import {
  AWS_SECRET_ACCESS_KEY_FIELD_KEYS,
  PAYMENT_CREDENTIAL_ENV_KEYS,
  PAYMENT_CREDENTIAL_JSON_KEYS,
  PAYMENT_CREDENTIAL_QUERY_KEYS,
} from "./redact-patterns.js";
import { shouldRedactStructuredAuthorizationCode } from "./structured-authorization-code.js";

const STRUCTURED_SECRET_FIELD_RE = new RegExp(
  String.raw`^(?:api[-_]?key|apiKey|api[-_]?token|apiToken|bearer[-_]?token|bearerToken|token|secret|password|passwd|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|private[-_]?key|privateKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|secret[-_]?value|secretValue|raw[-_]?secret|rawSecret|secret[-_]?input|secretInput|key|key[-_]?material|keyMaterial|jwt|session|signature|cookie|set[-_]?cookie|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`,
  "i",
);
const STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE = /^\$WORKSPACE_DIR\/[A-Za-z0-9._/-]+\.jsonl$/u;
const STRUCTURED_SECRET_ENV_FIELD_RE = new RegExp(
  String.raw`^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})$`,
  "i",
);

export function isShellReferenceToKey(key: string, value: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  const bare = value.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (bare) {
    return bare[1] === key;
  }
  const braced = value.match(/^\$\{([A-Z_][A-Z0-9_]*)(?::[-=?+])?\}$/);
  return braced?.[1] === key;
}

export function isSensitiveFieldKey(key: string): boolean {
  return STRUCTURED_SECRET_FIELD_RE.test(key) || STRUCTURED_SECRET_ENV_FIELD_RE.test(key);
}

export function isPublicShareIdPath(path: readonly string[]): boolean {
  if (path.at(-1)?.toLowerCase() !== "id") {
    return false;
  }
  const parentKey = path.at(-2)?.toLowerCase().replaceAll("-", "").replaceAll("_", "");
  return parentKey === "publicshare";
}

export function shouldRedactStructuredPrimitiveField(
  key: string,
  path: readonly string[],
): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    isPublicShareIdPath(path) ||
    shouldRedactStructuredAuthorizationCode(normalizedKey, path) ||
    isSensitiveFieldKey(key)
  );
}

function preservesStructuredReference(key: string, value: string): boolean {
  return (
    (key.toLowerCase() === "session" && STRUCTURED_INTERNAL_SOURCE_PATH_VALUE_RE.test(value)) ||
    isShellReferenceToKey(key, value)
  );
}

export function shouldRedactStructuredStringField(
  key: string,
  value: string,
  path: readonly string[],
  objectPath: boolean,
): boolean {
  return (
    shouldRedactStructuredAuthorizationCode(key.toLowerCase(), path, value, objectPath) ||
    (isSensitiveFieldKey(key) && !preservesStructuredReference(key, value))
  );
}

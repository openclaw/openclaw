import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isNonEmptyString } from "./shared.js";

const ALWAYS_SENSITIVE_MCP_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
  "cookie",
  "cookie2",
]);
const SENSITIVE_MCP_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "auth",
  "token",
  "secret",
  "password",
  "credential",
  "session",
];
const SENSITIVE_MCP_HEADER_NAME_SEGMENTS = new Set([
  "api",
  "auth",
  "token",
  "secret",
  "password",
  "credential",
  "session",
  "key",
]);
const SENSITIVE_MCP_ENV_NAME_FRAGMENTS = [
  "api_key",
  "apikey",
  "auth",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "private_key",
  "privatekey",
];
const SENSITIVE_MCP_ENV_NAME_SEGMENTS = new Set([
  "api",
  "auth",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "private",
  "key",
]);

const BENIGN_MCP_LITERAL_VALUES = new Set([
  "0",
  "1",
  "auto",
  "default",
  "debug",
  "disabled",
  "enabled",
  "error",
  "false",
  "info",
  "inherit",
  "no",
  "off",
  "on",
  "trace",
  "true",
  "warn",
  "warning",
  "yes",
]);

const URL_LIKE_MCP_LITERAL = /^(?:https?|wss?):\/\/\S+$/i;
const INTEGER_LIKE_MCP_LITERAL = /^[+-]?\d+$/;
const MIME_LIKE_MCP_LITERAL = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i;
const SENSITIVE_MCP_VALUE_FRAGMENTS = [
  "api-key",
  "api key",
  "apikey",
  "auth",
  "bearer ",
  "credential",
  "password",
  "secret",
  "token",
];

function tokenizeMcpName(value: string): string[] {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

export function isLikelySensitiveMcpHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (ALWAYS_SENSITIVE_MCP_HEADER_NAMES.has(normalized)) {
    return true;
  }
  if (SENSITIVE_MCP_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  return tokenizeMcpName(normalized).some((segment) =>
    SENSITIVE_MCP_HEADER_NAME_SEGMENTS.has(segment),
  );
}

export function isLikelySensitiveMcpEnvName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_MCP_ENV_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  return tokenizeMcpName(normalized).some((segment) => SENSITIVE_MCP_ENV_NAME_SEGMENTS.has(segment));
}

export function shouldAuditPlaintextMcpValue(params: {
  kind: "env" | "header";
  name: string;
  value: unknown;
}): boolean {
  const nameLooksSensitive =
    params.kind === "env"
      ? isLikelySensitiveMcpEnvName(params.name)
      : isLikelySensitiveMcpHeaderName(params.name);
  if (nameLooksSensitive) {
    return true;
  }

  const { value } = params;
  if (!isNonEmptyString(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (BENIGN_MCP_LITERAL_VALUES.has(normalized)) {
    return false;
  }
  if (URL_LIKE_MCP_LITERAL.test(trimmed)) {
    return false;
  }
  if (INTEGER_LIKE_MCP_LITERAL.test(trimmed)) {
    return false;
  }
  if (MIME_LIKE_MCP_LITERAL.test(trimmed)) {
    return false;
  }
  return SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

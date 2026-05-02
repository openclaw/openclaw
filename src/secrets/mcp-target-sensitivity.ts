import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
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

function getNormalizedMcpLiteralValue(
  value: unknown,
): { trimmed: string; normalized: string } | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    trimmed,
    normalized: normalizeLowercaseStringOrEmpty(trimmed),
  };
}

function isBenignMcpLiteralValue(value: unknown): boolean {
  const literal = getNormalizedMcpLiteralValue(value);
  if (!literal) {
    return false;
  }
  return (
    BENIGN_MCP_LITERAL_VALUES.has(literal.normalized) ||
    (URL_LIKE_MCP_LITERAL.test(literal.trimmed) && !hasSensitiveMcpUrlValue(literal.trimmed)) ||
    MIME_LIKE_MCP_LITERAL.test(literal.trimmed)
  );
}

function hasSensitiveMcpUrlValue(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) {
    return true;
  }
  for (const [key, paramValue] of parsed.searchParams.entries()) {
    if (isLikelySensitiveMcpEnvName(key) || isLikelySensitiveMcpHeaderName(key)) {
      return true;
    }
    const normalizedValue = normalizeLowercaseStringOrEmpty(paramValue);
    if (SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => normalizedValue.includes(fragment))) {
      return true;
    }
  }
  return false;
}

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
  const literal = getNormalizedMcpLiteralValue(params.value);
  if (!literal) {
    return false;
  }
  if (isBenignMcpLiteralValue(params.value)) {
    return false;
  }
  const nameLooksSensitive =
    params.kind === "env"
      ? isLikelySensitiveMcpEnvName(params.name)
      : isLikelySensitiveMcpHeaderName(params.name);
  if (nameLooksSensitive) {
    return true;
  }
  if (hasSensitiveMcpUrlValue(literal.trimmed)) {
    return true;
  }
  return SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => literal.normalized.includes(fragment));
}

export function shouldIncludeConfigureMcpCandidate(params: {
  kind: "env" | "header";
  name: string;
  value: unknown;
  refValue?: unknown;
}): boolean {
  const hasConfiguredRef = Boolean(
    resolveSecretInputRef({
      value: params.value,
      refValue: params.refValue,
    }).ref,
  );
  if (hasConfiguredRef) {
    return true;
  }
  const literal = getNormalizedMcpLiteralValue(params.value);
  const nameLooksSensitive =
    params.kind === "env"
      ? isLikelySensitiveMcpEnvName(params.name)
      : isLikelySensitiveMcpHeaderName(params.name);
  if (!literal || isBenignMcpLiteralValue(params.value)) {
    return false;
  }
  if (nameLooksSensitive) {
    return true;
  }
  if (hasSensitiveMcpUrlValue(literal.trimmed)) {
    return true;
  }
  return SENSITIVE_MCP_VALUE_FRAGMENTS.some((fragment) => literal.normalized.includes(fragment));
}

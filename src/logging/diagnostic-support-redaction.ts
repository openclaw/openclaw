import path from "node:path";
import { redactSensitiveText } from "./redact.js";

const SECRET_SUPPORT_FIELD_RE =
  /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PAYLOAD_SUPPORT_FIELD_RE =
  /(?:body|chat|content|detail|error|header|instruction|message|payload|prompt|result|text|tool|transcript)/iu;
const IDENTIFIER_SUPPORT_FIELD_RE =
  /(?:account[-_]?id|chat[-_]?id|conversation[-_]?id|email|message[-_]?id|phone|thread[-_]?id|user[-_]?id|username)/iu;
const PRIVATE_MAP_SUPPORT_FIELD_RE = /^(?:accounts|chats|conversations|messages|threads|users)$/iu;
const CONFIG_PRIVATE_FIELD_RE =
  /(?:allow[-_]?from|allow[-_]?to|deny[-_]?from|deny[-_]?to|blocked[-_]?from|blocked[-_]?users|owner[-_]?id|sender[-_]?id|recipient[-_]?id)/iu;
const SENSITIVE_COMMAND_ARG_RE =
  /^--(?:api[-_]?key|hook[-_]?token|password|password-file|passwd|secret|token)(?:=.*)?$/iu;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:?#]+):([^/@\s?#]+)@/giu;
const SENSITIVE_URL_PARAM_RE =
  /([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|hook[-_]?token|password|passwd|refresh[-_]?token|secret|token)=)[^&#\s]+/giu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MATRIX_USER_ID_RE = /@[A-Za-z0-9._=-]+:[A-Za-z0-9.-]+/gu;
const MATRIX_ROOM_ID_RE = /![A-Za-z0-9._=-]+:[A-Za-z0-9.-]+/gu;
const MATRIX_EVENT_ID_RE = /\$[A-Za-z0-9_-]{16,}/gu;
const HANDLE_RE = /(^|[^\w:/])@[A-Za-z0-9_]{5,}\b(?!\.)/gu;
const LONG_DECIMAL_ID_RE = /\b\d{9,}\b/gu;
const MAX_SUPPORT_STRING_LENGTH = 2000;
const MAX_SUPPORT_SNAPSHOT_DEPTH = 10;
const DEFAULT_TRUNCATION_SUFFIX = "...<truncated>";

export type SupportRedactionContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

type RedactSupportStringOptions = {
  maxLength?: number;
  truncationSuffix?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPrivateSupportField(key: string): boolean {
  return (
    SECRET_SUPPORT_FIELD_RE.test(key) ||
    PAYLOAD_SUPPORT_FIELD_RE.test(key) ||
    IDENTIFIER_SUPPORT_FIELD_RE.test(key)
  );
}

function isPrivateConfigField(key: string): boolean {
  return isPrivateSupportField(key) || CONFIG_PRIVATE_FIELD_RE.test(key);
}

function isSecretRefShape(value: Record<string, unknown>): boolean {
  return typeof value.source === "string" && typeof value.id === "string";
}

function sanitizeSecretRefForSupport(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  if (typeof value.source === "string") {
    sanitized.source = value.source;
  }
  if (typeof value.provider === "string") {
    sanitized.provider = value.provider;
  }
  sanitized.id = "<redacted>";
  return sanitized;
}

function privateMapEntryLabel(key: string): string {
  const normalized = key.toLowerCase();
  return normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
}

function pathRedactionPrefixes(options: SupportRedactionContext): Array<{
  prefix: string;
  label: string;
}> {
  const home = options.env.HOME ? path.resolve(options.env.HOME) : undefined;
  return [
    { prefix: path.resolve(options.stateDir), label: "$OPENCLAW_STATE_DIR" },
    ...(home ? [{ prefix: home, label: "~" }] : []),
  ].toSorted((a, b) => b.prefix.length - a.prefix.length);
}

export function redactPathForSupport(file: string, options: SupportRedactionContext): string {
  if (file.startsWith("$")) {
    return file;
  }
  const next = path.resolve(file);
  for (const { prefix, label } of pathRedactionPrefixes(options)) {
    if (next === prefix) {
      return label;
    }
    if (next.startsWith(`${prefix}${path.sep}`)) {
      return `${label}${next.slice(prefix.length)}`;
    }
  }
  return redactSensitiveText(next);
}

function redactKnownPathPrefixesForSupport(
  value: string,
  redaction: SupportRedactionContext,
): string {
  let next = value;
  for (const { prefix, label } of pathRedactionPrefixes(redaction)) {
    next = next.split(prefix).join(label);
  }
  return next;
}

export function redactTextForSupport(value: string): string {
  let redacted = redactSensitiveText(value);
  redacted = redactUrlSecretsForSupport(redacted);
  redacted = redactServiceIdentifiersForSupport(redacted);
  redacted = redactContactIdentifiersForSupport(redacted);
  return redactLongIdentifiersForSupport(redacted);
}

function redactUrlSecretsForSupport(value: string): string {
  return value
    .replace(URL_USERINFO_RE, "$1<redacted>:<redacted>@")
    .replace(SENSITIVE_URL_PARAM_RE, "$1<redacted>");
}

function redactContactIdentifiersForSupport(value: string): string {
  return value.replace(EMAIL_RE, "<redacted-email>").replace(HANDLE_RE, "$1<redacted-handle>");
}

function redactServiceIdentifiersForSupport(value: string): string {
  return value
    .replace(MATRIX_USER_ID_RE, "<redacted-matrix-user>")
    .replace(MATRIX_ROOM_ID_RE, "<redacted-matrix-room>")
    .replace(MATRIX_EVENT_ID_RE, "<redacted-matrix-event>");
}

function redactLongIdentifiersForSupport(value: string): string {
  return value.replace(LONG_DECIMAL_ID_RE, "<redacted-id>");
}

export function redactSupportString(
  value: string,
  redaction: SupportRedactionContext,
  options: RedactSupportStringOptions = {},
): string {
  const maxLength = options.maxLength ?? MAX_SUPPORT_STRING_LENGTH;
  const truncationSuffix = options.truncationSuffix ?? DEFAULT_TRUNCATION_SUFFIX;
  const redacted = redactTextForSupport(value);
  const pathRedacted = path.isAbsolute(redacted)
    ? redactPathForSupport(redacted, redaction)
    : redactKnownPathPrefixesForSupport(redacted, redaction);
  if (pathRedacted.length <= maxLength) {
    return pathRedacted;
  }
  return `${pathRedacted.slice(0, maxLength)}${truncationSuffix}`;
}

function sanitizeCommandArguments(args: unknown[], redaction: SupportRedactionContext): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return sanitizeSupportSnapshotValue(arg, redaction);
    }
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (SENSITIVE_COMMAND_ARG_RE.test(arg)) {
      if (!arg.includes("=")) {
        redactNext = true;
      }
      return arg.includes("=") ? arg.replace(/=.*/u, "=<redacted>") : arg;
    }
    return redactSupportString(arg, redaction);
  });
}

export function sanitizeSupportSnapshotValue(
  value: unknown,
  redaction: SupportRedactionContext,
  key = "",
  depth = 0,
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return isPrivateSupportField(key) ? "<redacted>" : redactSupportString(value, redaction);
  }
  if (depth >= MAX_SUPPORT_SNAPSHOT_DEPTH) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    if (key === "programArguments") {
      return sanitizeCommandArguments(value, redaction);
    }
    return value.map((entry) => sanitizeSupportSnapshotValue(entry, redaction, key, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return "<unsupported>";
  }
  if (PRIVATE_MAP_SUPPORT_FIELD_RE.test(key)) {
    return { count: Object.keys(record).length };
  }
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    sanitized[entryKey] = isPrivateSupportField(entryKey)
      ? "<redacted>"
      : sanitizeSupportSnapshotValue(entryValue, redaction, entryKey, depth + 1);
  }
  return sanitized;
}

export function sanitizeSupportConfigValue(
  value: unknown,
  redaction: SupportRedactionContext,
  key = "",
  depth = 0,
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return isPrivateConfigField(key) ? "<redacted>" : redactSupportString(value, redaction);
  }
  if (depth >= MAX_SUPPORT_SNAPSHOT_DEPTH) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    if (isPrivateConfigField(key)) {
      return {
        redacted: true,
        count: value.length,
      };
    }
    return value.map((entry) => sanitizeSupportConfigValue(entry, redaction, key, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return "<unsupported>";
  }
  if (isPrivateConfigField(key)) {
    return isSecretRefShape(record) ? sanitizeSecretRefForSupport(record) : "<redacted>";
  }

  const sanitized: Record<string, unknown> = {};
  let privateEntryIndex = 0;
  const redactEntryKeys = PRIVATE_MAP_SUPPORT_FIELD_RE.test(key);
  const privateEntryLabel = redactEntryKeys ? privateMapEntryLabel(key) : "";
  for (const [entryKey, entryValue] of Object.entries(record).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    let outputKey = entryKey;
    if (redactEntryKeys) {
      privateEntryIndex += 1;
      outputKey = `<redacted-${privateEntryLabel}-${privateEntryIndex}>`;
    }
    sanitized[outputKey] = sanitizeSupportConfigValue(entryValue, redaction, entryKey, depth + 1);
  }
  return sanitized;
}

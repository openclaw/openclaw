// Logger implementation writes structured log output with redaction and transports.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import type { OpenClawConfig } from "../config/types.js";
import {
  emitDiagnosticEvent,
  emitDiagnosticEventWithTrustedTraceContext,
} from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { appendRegularFileSync } from "../infra/regular-file.js";
import {
  POSIX_OPENCLAW_TMP_DIR,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { canUseNodeFs, formatLocalDate, LOG_PREFIX, LOG_SUFFIX } from "./log-file-shared.js";
import { redactSecrets, redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";
import type { LoggerSettings } from "./types.js";
export type { LoggerSettings } from "./types.js";

function resolveDefaultLogDir(): string {
  return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}

function resolveDefaultLogFile(defaultLogDir: string): string {
  return canUseNodeFs()
    ? path.join(defaultLogDir, "openclaw.log")
    : `${POSIX_OPENCLAW_TMP_DIR}/openclaw.log`;
}

export const DEFAULT_LOG_DIR = resolveDefaultLogDir();
export const DEFAULT_LOG_FILE = resolveDefaultLogFile(DEFAULT_LOG_DIR); // legacy single-file path

const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_LOG_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_ROTATED_LOG_FILES = 5;

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: LogLevel;
  file: string;
  maxFileBytes: number;
};
export type LoggerResolvedSettings = ResolvedSettings;
type TsLogRecord = Record<string, unknown>;
type LoggerConfigLoader = () => OpenClawConfig["logging"] | undefined;
type HostnameResolver = () => string;

type DiagnosticLogCode = {
  line?: number;
  functionName?: string;
  siteId?: string;
};
export type DiagnosticLogSource = {
  filePath?: string;
  line?: number;
  functionName?: string;
};

const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS = 4 * 1024;

const loadLoggerConfigDefault: LoggerConfigLoader = () => readLoggingConfig();
let loadLoggerConfig: LoggerConfigLoader = loadLoggerConfigDefault;

export function setLoggerConfigLoaderForTests(loader?: LoggerConfigLoader): void {
  loadLoggerConfig = loader ?? loadLoggerConfigDefault;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
}
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT = 32;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS = 2 * 1024;
const MAX_DIAGNOSTIC_LOG_NAME_CHARS = 120;
const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_FILE_LOG_CONTEXT_VALUE_CHARS = 512;
const DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const DIAGNOSTIC_LOG_SEMANTIC_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const DIAGNOSTIC_LOG_REASON_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;
const DIAGNOSTIC_LOG_SEMANTIC_SOURCE_KEYS = new Set([
  "eventName",
  "logEvent",
  "logCategory",
  "logOutcome",
  "logReason",
  "otel.event.name",
  "signal.type",
  "log.event",
  "log.category",
  "log.outcome",
  "log.reason",
  "__openclawDiagnosticLogSemantics",
  "__openclawDiagnosticLogSource",
]);
const DIAGNOSTIC_LOG_SEMANTICS_FIELD = "__openclawDiagnosticLogSemantics";
const DIAGNOSTIC_LOG_SOURCE_FIELD = "__openclawDiagnosticLogSource";
const DIAGNOSTIC_LOG_SEMANTICS_TOKEN = `${Date.now()}:${Math.random()}`;
const defaultHostnameResolver: HostnameResolver = () => os.hostname();
let hostnameResolver: HostnameResolver = defaultHostnameResolver;
let cachedHostname: string | null = null;

type DiagnosticLogAttributes = Record<string, string | number | boolean>;
type DiagnosticLogSemantics = {
  event?: unknown;
  category?: unknown;
  outcome?: unknown;
  reason?: unknown;
};
type DiagnosticLogCategoryCandidate = {
  value: unknown;
  source: string;
};
type AttachedDiagnosticLogSemantics = {
  fields: DiagnosticLogSemantics;
  proof: string;
};
type AttachedDiagnosticLogSource = {
  fields: DiagnosticLogSource;
  proof: string;
};
const STRIPPED_DIAGNOSTIC_LOG_VALUE = Symbol("strippedDiagnosticLogValue");

function readAttachedDiagnosticLogSemantics(
  source: Record<string, unknown> | undefined,
): DiagnosticLogSemantics | undefined {
  const candidate = source?.[DIAGNOSTIC_LOG_SEMANTICS_FIELD] as
    | AttachedDiagnosticLogSemantics
    | undefined;
  return candidate?.proof === DIAGNOSTIC_LOG_SEMANTICS_TOKEN ? candidate.fields : undefined;
}

function readAttachedDiagnosticLogSource(
  source: Record<string, unknown> | undefined,
): DiagnosticLogSource | undefined {
  const candidate = source?.[DIAGNOSTIC_LOG_SOURCE_FIELD] as
    | AttachedDiagnosticLogSource
    | undefined;
  return candidate?.proof === DIAGNOSTIC_LOG_SEMANTICS_TOKEN ? candidate.fields : undefined;
}

export function attachDiagnosticLogSemantics<T extends Record<string, unknown>>(
  source: T,
  semantics: DiagnosticLogSemantics,
): T {
  source[DIAGNOSTIC_LOG_SEMANTICS_FIELD] = {
    fields: semantics,
    proof: DIAGNOSTIC_LOG_SEMANTICS_TOKEN,
  };
  return source;
}

export function hasDiagnosticLogSemantics(source: Record<string, unknown> | undefined): boolean {
  return Boolean(readAttachedDiagnosticLogSemantics(source));
}

export function attachDiagnosticLogSource<T extends Record<string, unknown>>(
  source: T,
  diagnosticSource: DiagnosticLogSource,
): T {
  source[DIAGNOSTIC_LOG_SOURCE_FIELD] = {
    fields: diagnosticSource,
    proof: DIAGNOSTIC_LOG_SEMANTICS_TOKEN,
  };
  return source;
}

export function splitDiagnosticLogSemanticFields(source: Record<string, unknown> | undefined): {
  attributes?: Record<string, unknown>;
  semantics?: DiagnosticLogSemantics;
} {
  if (!source) {
    return {};
  }
  const attributes: Record<string, unknown> = {};
  const semantics: DiagnosticLogSemantics = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "logEvent") {
      semantics.event = value;
      continue;
    }
    if (key === "logCategory") {
      semantics.category = value;
      continue;
    }
    if (key === "logOutcome") {
      semantics.outcome = value;
      continue;
    }
    if (key === "logReason") {
      semantics.reason = value;
      continue;
    }
    attributes[key] = value;
  }
  return {
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(semantics).length > 0 ? { semantics } : {}),
  };
}

function clampDiagnosticLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function sanitizeDiagnosticLogText(value: string, maxChars: number): string {
  return clampDiagnosticLogText(
    redactSensitiveText(clampDiagnosticLogText(value, maxChars)),
    maxChars,
  );
}

function normalizeDiagnosticLogName(value: string | undefined): string | undefined {
  if (!value || value.trim().startsWith("{")) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  return DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(sanitized) ? sanitized : undefined;
}

function normalizeDiagnosticLogSemanticValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS)
    .replace(/[/:]+/gu, ".")
    .replace(/\s+/gu, "-")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "");
  return DIAGNOSTIC_LOG_SEMANTIC_VALUE_RE.test(normalized) ? normalized : fallback;
}

function diagnosticLogEventFromCategory(category: string, level: string): string {
  if (category === "unknown") {
    return "log.record";
  }
  const levelSegment = normalizeDiagnosticLogSemanticValue(level.toLowerCase(), "log");
  return `${category}.${levelSegment}`;
}

function normalizeDiagnosticLogCategorySegment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS)
    .replace(/[/:]+/gu, ".")
    .replace(/[^A-Za-z0-9_.:-]+/gu, ".")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "")
    .toLowerCase();
  return DIAGNOSTIC_LOG_SEMANTIC_VALUE_RE.test(normalized) ? normalized : undefined;
}

function firstDiagnosticLogCategoryCandidate(
  sources: readonly (Record<string, unknown> | undefined)[],
): DiagnosticLogCategoryCandidate | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const semanticValue = readDiagnosticLogSemanticValue(source, "category");
    if (semanticValue !== undefined) {
      return { value: semanticValue, source: "semantic" };
    }
    if (Object.hasOwn(source, "logCategory")) {
      return { value: source.logCategory, source: "logCategory" };
    }
  }

  const bindings = sources[1];
  if (!bindings) {
    return undefined;
  }
  for (const key of ["subsystem", "module", "name", "capability"]) {
    if (Object.hasOwn(bindings, key)) {
      return { value: bindings[key], source: key };
    }
  }
  if (Object.hasOwn(bindings, "feature") && Object.hasOwn(bindings, "plugin")) {
    return {
      value: `${String(bindings.plugin)}.${String(bindings.feature)}`,
      source: "plugin.feature",
    };
  }
  if (Object.hasOwn(bindings, "plugin")) {
    return { value: bindings.plugin, source: "plugin" };
  }
  return undefined;
}

function normalizeDiagnosticLogEventSegment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS)
    .replace(/[<>]/gu, "")
    .replace(/[^A-Za-z0-9_.:-]+/gu, ".")
    .replace(/\.+/gu, ".")
    .replace(/^\.|\.$/gu, "")
    .toLowerCase();
  return DIAGNOSTIC_LOG_SEMANTIC_VALUE_RE.test(normalized) ? normalized : undefined;
}

function diagnosticLogEventFromCode(category: string, level: string, code: DiagnosticLogCode) {
  const levelSegment = normalizeDiagnosticLogSemanticValue(level.toLowerCase(), "log");
  const functionSegment = normalizeDiagnosticLogEventSegment(code.functionName);
  if (category === "unknown") {
    return functionSegment ? `log.${functionSegment}.${levelSegment}` : "log.record";
  }
  return functionSegment
    ? `${category}.${functionSegment}.${levelSegment}`
    : diagnosticLogEventFromCategory(category, level);
}

function normalizeDiagnosticSourcePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = value.replace(/\\/gu, "/");
  for (const root of ["src/", "extensions/", "packages/", "ui/", "docs/"]) {
    if (normalized.startsWith(root)) {
      return normalized;
    }
  }
  const rootMarkerIndex = ["src/", "extensions/", "packages/", "ui/", "docs/"].reduce<
    number | undefined
  >((best, root) => {
    const index = normalized.indexOf(`/${root}`);
    if (index < 0) {
      return best;
    }
    return best === undefined || index < best ? index : best;
  }, undefined);
  if (rootMarkerIndex !== undefined) {
    return normalized.slice(rootMarkerIndex + 1);
  }
  const basename = path.basename(normalized);
  return basename || undefined;
}

function diagnosticLogSiteId(params: {
  filePath?: unknown;
  line?: number;
  functionName?: string;
  category: string;
  level: string;
}): string | undefined {
  const sourcePath = normalizeDiagnosticSourcePath(params.filePath);
  const functionName = normalizeDiagnosticLogEventSegment(params.functionName) ?? "unknown";
  const line = params.line ?? "unknown";
  if (!sourcePath && line === "unknown" && functionName === "unknown") {
    return undefined;
  }
  const seed = `${sourcePath ?? "unknown"}:${line}:${functionName}:${params.category}:${
    params.level
  }`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function diagnosticLogOutcomeFromLevel(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
    case "FATAL":
      return "failure";
    case "WARN":
      return "warning";
    case "INFO":
      return "success";
    default:
      return "unknown";
  }
}

function normalizeDiagnosticLogReasonCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  if (!normalized || normalized !== value.trim()) {
    return undefined;
  }
  return DIAGNOSTIC_LOG_REASON_CODE_RE.test(normalized) ? normalized : undefined;
}

function diagnosticLogOutcomeFromStatus(value: unknown): string | undefined {
  const status = normalizeDiagnosticLogReasonCode(value)?.toLowerCase();
  if (!status) {
    return undefined;
  }
  if (
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    status.endsWith("-failed") ||
    status.endsWith("_failed")
  ) {
    return "failure";
  }
  if (
    status === "skipped" ||
    status === "warning" ||
    status === "deferred" ||
    status === "blocked" ||
    status.endsWith("-skipped") ||
    status.endsWith("_skipped")
  ) {
    return "warning";
  }
  if (
    status === "ok" ||
    status === "success" ||
    status === "started" ||
    status === "sent" ||
    status === "ran" ||
    status.endsWith("-ok") ||
    status.endsWith("_ok")
  ) {
    return "success";
  }
  return undefined;
}

function readDiagnosticLogSemanticValue(
  source: Record<string, unknown> | undefined,
  key: keyof DiagnosticLogSemantics,
): unknown {
  if (!source) {
    return undefined;
  }
  const semantics = readAttachedDiagnosticLogSemantics(source);
  return semantics?.[key];
}

function stripDiagnosticLogInternalFieldsFromValue(
  value: unknown,
): unknown | typeof STRIPPED_DIAGNOSTIC_LOG_VALUE {
  if (
    !isPlainLogRecordObject(value) ||
    (!hasDiagnosticLogSemantics(value) && !readAttachedDiagnosticLogSource(value))
  ) {
    return value;
  }
  const copy = { ...value };
  delete copy[DIAGNOSTIC_LOG_SEMANTICS_FIELD];
  delete copy[DIAGNOSTIC_LOG_SOURCE_FIELD];
  if (Object.keys(copy).length === 0) {
    return STRIPPED_DIAGNOSTIC_LOG_VALUE;
  }
  return copy;
}

function stripDiagnosticLogSemanticsFromRecord<T extends LogObj>(record: T): T {
  const copy = { ...record };
  for (const key of Object.keys(copy)) {
    const stripped = stripDiagnosticLogInternalFieldsFromValue(copy[key]);
    if (stripped === STRIPPED_DIAGNOSTIC_LOG_VALUE) {
      delete copy[key];
    } else {
      copy[key] = stripped;
    }
  }
  const numericEntries = Object.entries(copy)
    .filter(([key]) => /^\d+$/u.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]));
  if (numericEntries.some(([key], index) => key !== String(index))) {
    for (const [key] of numericEntries) {
      delete copy[key];
    }
    numericEntries.forEach(([, value], index) => {
      copy[String(index)] = value;
    });
  }
  return copy;
}

function assignDiagnosticLogAttribute(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  key: string,
  value: unknown,
): void {
  if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
    return;
  }
  const normalizedKey = key.trim();
  if (isBlockedObjectKey(normalizedKey)) {
    return;
  }
  if (redactSensitiveText(normalizedKey) !== normalizedKey) {
    return;
  }
  if (!DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(normalizedKey)) {
    return;
  }
  if (typeof value === "string") {
    attributes[normalizedKey] = sanitizeDiagnosticLogText(
      value,
      MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS,
    );
    state.count += 1;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[normalizedKey] = value;
    state.count += 1;
    return;
  }
  if (typeof value === "boolean") {
    attributes[normalizedKey] = value;
    state.count += 1;
  }
}

function addDiagnosticLogAttributesFrom(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  source: Record<string, unknown> | undefined,
): void {
  if (!source) {
    return;
  }
  for (const key in source) {
    if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    if (!Object.hasOwn(source, key) || key === "trace") {
      continue;
    }
    if (DIAGNOSTIC_LOG_SEMANTIC_SOURCE_KEYS.has(key.trim())) {
      continue;
    }
    assignDiagnosticLogAttribute(attributes, state, key, source[key]);
  }
}

function isPlainLogRecordObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

function extractTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  const direct = normalizeTraceContext(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return normalizeTraceContext((value as { trace?: unknown }).trace);
}

function getSortedNumericLogArgs(logObj: TsLogRecord): unknown[] {
  return Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);
}

function clampFileLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function normalizeFileLogContextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? clampFileLogText(normalized, MAX_FILE_LOG_CONTEXT_VALUE_CHARS) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readFirstContextString(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const value = normalizeFileLogContextValue(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function stringifyFileLogMessagePart(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (isPlainLogRecordObject(value) && typeof value.message === "string") {
    return value.message;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function buildFileLogMessage(numericArgs: readonly unknown[]): string | undefined {
  const parts = numericArgs
    .map(stringifyFileLogMessagePart)
    .filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) {
    return undefined;
  }
  return clampFileLogText(parts.join(" "), MAX_FILE_LOG_MESSAGE_CHARS);
}

function resolveLogHostname(): string {
  if (cachedHostname) {
    return cachedHostname;
  }
  const hostname = hostnameResolver().trim();
  if (!hostname) {
    return "unknown";
  }
  cachedHostname = hostname;
  return hostname;
}

function withResolvedLogMetaHostname(meta: unknown, hostname: string): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta;
  }
  return { ...(meta as Record<string, unknown>), hostname };
}

function extractLogBindingPrefix(numericArgs: unknown[]): {
  bindings?: Record<string, unknown>;
  args: unknown[];
} {
  if (
    typeof numericArgs[0] === "string" &&
    numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS &&
    numericArgs[0].trim().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(numericArgs[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          bindings: parsed as Record<string, unknown>,
          args: numericArgs.slice(1),
        };
      }
    } catch {
      // ignore malformed json bindings
    }
  }
  return { args: numericArgs };
}

function findLogTraceContext(
  bindings: Record<string, unknown> | undefined,
  numericArgs: readonly unknown[],
): DiagnosticTraceContext | undefined {
  const fromBindings = extractTraceContext(bindings);
  if (fromBindings) {
    return fromBindings;
  }
  for (const arg of numericArgs) {
    const fromArg = extractTraceContext(arg);
    if (fromArg) {
      return fromArg;
    }
  }
  return undefined;
}

function resolveLogTraceContext(
  bindings: Record<string, unknown> | undefined,
  numericArgs: readonly unknown[],
): { trace?: DiagnosticTraceContext; trustedTraceContext: boolean } {
  const explicitTrace = findLogTraceContext(bindings, numericArgs);
  if (explicitTrace) {
    return { trace: explicitTrace, trustedTraceContext: false };
  }
  const activeTrace = getActiveDiagnosticTraceContext();
  return activeTrace
    ? { trace: activeTrace, trustedTraceContext: true }
    : { trustedTraceContext: false };
}

function buildTraceFileLogFields(logObj: TsLogRecord): Record<string, string> | undefined {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const { trace } = resolveLogTraceContext(bindings, args);
  if (!trace) {
    return undefined;
  }
  return {
    traceId: trace.traceId,
    ...(trace.spanId ? { spanId: trace.spanId } : {}),
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    ...(trace.traceFlags ? { traceFlags: trace.traceFlags } : {}),
  };
}

function buildStructuredFileLogFields(logObj: TsLogRecord): Record<string, string> {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const structuredArg = isPlainLogRecordObject(args[0]) ? args[0] : undefined;
  const sources = [structuredArg, bindings, logObj];
  const messageArgs =
    structuredArg && typeof structuredArg.message !== "string" ? args.slice(1) : args;
  const message = buildFileLogMessage(messageArgs);
  const agentId = readFirstContextString(sources, ["agent_id", "agentId"]);
  const sessionId = readFirstContextString(sources, ["session_id", "sessionId", "sessionKey"]);
  const channel = readFirstContextString(sources, ["channel", "messageProvider"]);
  return {
    hostname: resolveLogHostname(),
    ...(message ? { message } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(channel ? { channel } : {}),
  };
}

function buildDiagnosticLogRecord(logObj: TsLogRecord) {
  const meta = logObj["_meta"] as
    | {
        logLevelName?: string;
        date?: Date;
        name?: string;
        parentNames?: string[];
        path?: {
          filePath?: string;
          fileLine?: string;
          fileColumn?: string;
          filePathWithLine?: string;
          method?: string;
        };
      }
    | undefined;
  const { bindings, args: numericArgs } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));

  const { trace, trustedTraceContext } = resolveLogTraceContext(bindings, numericArgs);
  const structuredArg = numericArgs[0];
  const structuredBindings = isPlainLogRecordObject(structuredArg) ? structuredArg : undefined;
  if (structuredBindings) {
    numericArgs.shift();
  }

  let message = "";
  if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
    message = sanitizeDiagnosticLogText(
      String(numericArgs.pop()),
      MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS,
    );
  } else if (
    numericArgs.length === 1 &&
    (typeof numericArgs[0] === "number" || typeof numericArgs[0] === "boolean")
  ) {
    message = String(numericArgs[0]);
    numericArgs.length = 0;
  }
  if (!message) {
    message = "log";
  }

  const attributes: DiagnosticLogAttributes = Object.create(null) as DiagnosticLogAttributes;
  const attributeState = { count: 0 };
  addDiagnosticLogAttributesFrom(attributes, attributeState, bindings);
  addDiagnosticLogAttributesFrom(attributes, attributeState, structuredBindings);

  const diagnosticSource = readAttachedDiagnosticLogSource(structuredBindings);
  const hasDiagnosticSource = Boolean(diagnosticSource);
  const code: DiagnosticLogCode = {};
  const sourceLine = diagnosticSource?.line ?? meta?.path?.fileLine;
  if (sourceLine !== undefined) {
    const line = Number(sourceLine);
    if (Number.isFinite(line)) {
      code.line = line;
    }
  }
  const sourceFunctionName = hasDiagnosticSource
    ? diagnosticSource?.functionName
    : meta?.path?.method;
  if (sourceFunctionName) {
    code.functionName = sanitizeDiagnosticLogText(
      sourceFunctionName,
      MAX_DIAGNOSTIC_LOG_NAME_CHARS,
    );
  }

  const loggerName = normalizeDiagnosticLogName(meta?.name);
  const loggerParents = meta?.parentNames
    ?.map(normalizeDiagnosticLogName)
    .filter((name): name is string => Boolean(name));
  const semanticSources = [structuredBindings, bindings] as const;
  const firstSemanticSourceValue = (
    semanticKey: keyof DiagnosticLogSemantics,
    keys: readonly string[],
  ) => {
    for (const source of semanticSources) {
      if (!source) {
        continue;
      }
      const semanticValue = readDiagnosticLogSemanticValue(source, semanticKey);
      if (semanticValue !== undefined) {
        return semanticValue;
      }
      for (const key of keys) {
        if (Object.hasOwn(source, key)) {
          return source[key];
        }
      }
    }
    return undefined;
  };
  const categoryCandidate = firstDiagnosticLogCategoryCandidate(semanticSources);
  const firstReasonCodeValue = (keys: readonly string[]) => {
    for (const source of semanticSources) {
      if (!source) {
        continue;
      }
      for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
          continue;
        }
        const reason = normalizeDiagnosticLogReasonCode(source[key]);
        if (reason) {
          return reason;
        }
      }
    }
    return undefined;
  };
  const logLevelName = meta?.logLevelName ?? "INFO";
  const category =
    normalizeDiagnosticLogCategorySegment(categoryCandidate?.value) ??
    normalizeDiagnosticLogSemanticValue(categoryCandidate?.value, "unknown");
  if (
    categoryCandidate?.source &&
    categoryCandidate.source !== "semantic" &&
    categoryCandidate.source !== "subsystem" &&
    categoryCandidate.source !== "logCategory"
  ) {
    assignDiagnosticLogAttribute(
      attributes,
      attributeState,
      "log.category_source",
      categoryCandidate.source,
    );
  }
  const event = normalizeDiagnosticLogSemanticValue(
    firstSemanticSourceValue("event", ["logEvent"]),
    diagnosticLogEventFromCode(category, logLevelName, code),
  );
  const siteId = diagnosticLogSiteId({
    filePath: diagnosticSource?.filePath ?? meta?.path?.filePath,
    line: code.line,
    functionName: code.functionName,
    category,
    level: logLevelName,
  });
  if (siteId) {
    code.siteId = siteId;
  }
  const statusOutcome = diagnosticLogOutcomeFromStatus(
    firstSemanticSourceValue("outcome", ["logOutcome"]) ??
      firstReasonCodeValue(["status", "state"]),
  );
  const outcome = normalizeDiagnosticLogSemanticValue(
    firstSemanticSourceValue("outcome", ["logOutcome"]),
    statusOutcome ?? diagnosticLogOutcomeFromLevel(logLevelName),
  );
  const sourceReason = firstReasonCodeValue(["reason", "status", "state", "errorCategory"]);
  const reason = normalizeDiagnosticLogSemanticValue(
    firstSemanticSourceValue("reason", ["logReason"]),
    sourceReason ?? (outcome === "warning" || outcome === "failure" ? outcome : "none"),
  );

  return {
    event: {
      type: "log.record" as const,
      level: meta?.logLevelName ?? "INFO",
      message,
      event,
      category,
      outcome,
      reason,
      ...(loggerName ? { loggerName } : {}),
      ...(loggerParents?.length ? { loggerParents } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(Object.keys(code).length > 0 ? { code } : {}),
      ...(trace ? { trace } : {}),
    },
    trustedTraceContext,
  };
}

function isLogRedactionDisabled(): boolean {
  return readLoggingConfig()?.redactSensitive === "off";
}

function redactLogRecordForTransport<T extends LogObj>(record: T): T {
  return isLogRedactionDisabled() ? record : redactSecrets(record);
}

function attachDiagnosticEventTransport(logger: TsLogger<LogObj>): void {
  logger.attachTransport((logObj: LogObj) => {
    try {
      const record = buildDiagnosticLogRecord(redactLogRecordForTransport(logObj) as TsLogRecord);
      const emit = record.trustedTraceContext
        ? emitDiagnosticEventWithTrustedTraceContext
        : emitDiagnosticEvent;
      emit(record.event);
    } catch {
      // never block on logging failures
    }
  });
}

function canUseSilentVitestFileLogFastPath(envLevel: LogLevel | undefined): boolean {
  return (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_FILE_LOG !== "1" &&
    !envLevel &&
    !loggingState.overrideSettings
  );
}

function resolveDefaultActiveLogFile(): string {
  if (process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG === "1") {
    return path.join(
      process.cwd(),
      ".artifacts",
      "test-logs",
      `${LOG_PREFIX}-vitest-${process.pid}-${formatLocalDate(new Date())}${LOG_SUFFIX}`,
    );
  }
  return defaultRollingPathForToday();
}

function resolveSettings(): ResolvedSettings {
  if (!canUseNodeFs()) {
    return {
      level: "silent",
      file: DEFAULT_LOG_FILE,
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  const envLevel = resolveEnvLogLevelOverride();
  // Test runs default file logs to silent. Skip config reads and fallback load in the
  // common case to avoid pulling heavy config/schema stacks on startup.
  if (canUseSilentVitestFileLogFastPath(envLevel)) {
    return {
      level: "silent",
      file: defaultRollingPathForToday(),
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  const cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? loadLoggerConfig();
  const defaultLevel =
    process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
  const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
  const level = envLevel ?? fromConfig;
  const file = cfg?.file ?? resolveDefaultActiveLogFile();
  const maxFileBytes = resolveMaxLogFileBytes(cfg?.maxFileBytes);
  return { level, file, maxFileBytes };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (level === "silent") {
    return false;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  const logger = new TsLogger<LogObj>({
    name: "openclaw",
    // Custom structured redaction runs at each transport boundary; avoid tslog pre-masking divergent records.
    maskValuesOfKeys: [],
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // no ansi formatting
  });

  // Silent logging does not write files; skip all filesystem setup in this path.
  if (settings.level === "silent") {
    attachDiagnosticEventTransport(logger);
    return logger;
  }

  const rollingFile = isRollingPath(settings.file);
  let activeFile = resolveActiveLogFile(settings.file);
  fs.mkdirSync(path.dirname(activeFile), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (rollingFile) {
    pruneOldRollingLogs(path.dirname(activeFile));
  }
  let currentFileBytes = getCurrentLogFileBytes(activeFile);
  let warnedAboutRotationFailure = false;

  logger.attachTransport((logObj: LogObj) => {
    try {
      const nextActiveFile = resolveActiveLogFile(settings.file);
      if (nextActiveFile !== activeFile) {
        activeFile = nextActiveFile;
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        if (rollingFile) {
          pruneOldRollingLogs(path.dirname(activeFile));
        }
        currentFileBytes = getCurrentLogFileBytes(activeFile);
      }
      const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
      const traceFields = buildTraceFileLogFields(logObj as TsLogRecord);
      const structuredFields = buildStructuredFileLogFields(logObj as TsLogRecord);
      const visibleLogObj = stripDiagnosticLogSemanticsFromRecord(logObj);
      const record = {
        ...visibleLogObj,
        _meta: withResolvedLogMetaHostname(logObj["_meta"], structuredFields.hostname),
        time,
        ...structuredFields,
        ...traceFields,
      };
      const line = redactSensitiveText(JSON.stringify(redactLogRecordForTransport(record)));
      const payload = `${line}\n`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const nextBytes = currentFileBytes + payloadBytes;
      if (currentFileBytes > 0 && nextBytes > settings.maxFileBytes) {
        if (rotateLogFile(activeFile)) {
          currentFileBytes = getCurrentLogFileBytes(activeFile);
          warnedAboutRotationFailure = false;
        } else if (!warnedAboutRotationFailure) {
          warnedAboutRotationFailure = true;
          process.stderr.write(
            `[openclaw] log file rotation failed; continuing writes file=${activeFile} maxFileBytes=${settings.maxFileBytes}\n`,
          );
        }
      }
      if (appendLogLine(activeFile, payload)) {
        currentFileBytes += payloadBytes;
      }
    } catch {
      // never block on logging failures
    }
  });
  attachDiagnosticEventTransport(logger);

  return logger;
}

function resolveMaxLogFileBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_LOG_FILE_BYTES;
}

function getCurrentLogFileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function appendLogLine(file: string, line: string): boolean {
  try {
    appendRegularFileSync({ filePath: file, content: line });
    return true;
  } catch {
    return false;
  }
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
        minLevel: logger.settings.minLevel,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
}

export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
  loadLoggerConfig = loadLoggerConfigDefault;
  hostnameResolver = defaultHostnameResolver;
  cachedHostname = null;
}

export const testApi = {
  normalizeDiagnosticSourcePath,
  resolveActiveLogFile,
  setHostnameResolverForTests: (resolver?: HostnameResolver) => {
    hostnameResolver = resolver ?? defaultHostnameResolver;
    cachedHostname = null;
  },
  shouldSkipMutatingLoggingConfigRead,
};
export { testApi as __test__ };

function defaultRollingPathForToday(): string {
  return rollingPathForDate(DEFAULT_LOG_DIR, new Date());
}

function rollingPathForDate(dir: string, date: Date): string {
  const today = formatLocalDate(date);
  return path.join(dir, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

function resolveActiveLogFile(file: string): string {
  const expandedFile = expandHomePrefix(file);
  if (!isRollingPath(expandedFile)) {
    return expandedFile;
  }
  return rollingPathForDate(path.dirname(expandedFile), new Date());
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

function rotateLogFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (!fs.existsSync(from)) {
        continue;
      }
      fs.renameSync(from, rotatedLogPath(file, index + 1));
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}

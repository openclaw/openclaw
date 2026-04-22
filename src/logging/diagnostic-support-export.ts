import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import { parseConfigJson5 } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { VERSION } from "../version.js";
import {
  readDiagnosticStabilityBundleFileSync,
  readLatestDiagnosticStabilityBundleSync,
  type ReadDiagnosticStabilityBundleResult,
} from "./diagnostic-stability-bundle.js";
import {
  redactPathForSupport,
  redactSupportString,
  redactTextForSupport,
  sanitizeSupportConfigValue,
  sanitizeSupportSnapshotValue,
  type SupportRedactionContext,
} from "./diagnostic-support-redaction.js";
import { readConfiguredLogTail, type LogTailPayload } from "./log-tail.js";

export const DIAGNOSTIC_SUPPORT_EXPORT_VERSION = 1;

const DEFAULT_LOG_LIMIT = 5000;
const DEFAULT_LOG_MAX_BYTES = 1_000_000;
const SUPPORT_EXPORT_PREFIX = "openclaw-diagnostics-";
const SUPPORT_EXPORT_SUFFIX = ".zip";
const LOG_STRING_FIELD_RE =
  /^(?:action|channel|code|component|endpoint|event|handshake|kind|level|localAddr|logger|method|model|module|msg|name|outcome|phase|pluginId|provider|reason|remoteAddr|requestId|runId|service|sessionId|sessionKey|source|status|subsystem|surface|target|time|traceId|type)$/iu;
const LOG_SCALAR_FIELD_RE =
  /^(?:active|attempt|bytes|count|durationMs|enabled|exitCode|intervalMs|jobs|limitBytes|localPort|nextWakeAtMs|pid|port|queueDepth|queued|remotePort|statusCode|waitMs|waiting)$/iu;
const OMITTED_LOG_FIELD_RE =
  /(?:authorization|body|chat|content|cookie|credential|detail|error|header|instruction|message|password|payload|prompt|result|secret|text|token|tool|transcript|url)/iu;
const UNSAFE_LOG_MESSAGE_RE =
  /(?:\b(?:ai response|assistant said|chat text|message contents|prompt|raw webhook body|tool output|tool result|transcript|user said|webhook body)\b|auto-responding\b.*:\s*["']|partial for\b.*:)/iu;
const MAX_LOG_STRING_LENGTH = 240;
const LOGTAPE_META_FIELD = "_meta";
const LOGTAPE_ARG_FIELD_RE = /^\d+$/u;

const LOGTAPE_META_STRING_FIELDS = new Map([
  ["logLevelName", "level"],
  ["name", "logger"],
]);

type Awaitable<T> = T | Promise<T>;
type SupportSnapshotReader = () => Awaitable<unknown>;

export type DiagnosticSupportExportOptions = {
  outputPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  now?: Date;
  logLimit?: number;
  logMaxBytes?: number;
  stabilityBundle?: string | false;
  readLogTail?: typeof readConfiguredLogTail;
  readStatusSnapshot?: SupportSnapshotReader;
  readHealthSnapshot?: SupportSnapshotReader;
};

export type DiagnosticSupportExportManifest = {
  version: typeof DIAGNOSTIC_SUPPORT_EXPORT_VERSION;
  generatedAt: string;
  openclawVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  stateDir: string;
  contents: Array<{
    path: string;
    mediaType: string;
    bytes: number;
  }>;
  privacy: {
    payloadFree: true;
    rawLogsIncluded: false;
    notes: string[];
  };
};

export type DiagnosticSupportExportFile = {
  path: string;
  mediaType: string;
  content: string;
};

export type DiagnosticSupportExportArtifact = {
  manifest: DiagnosticSupportExportManifest;
  files: DiagnosticSupportExportFile[];
};

export type WriteDiagnosticSupportExportResult = {
  path: string;
  bytes: number;
  manifest: DiagnosticSupportExportManifest;
};

type ConfigShape = {
  path: string;
  exists: boolean;
  parseOk: boolean;
  bytes?: number;
  mtime?: string;
  error?: string;
  topLevelKeys: string[];
  gateway?: {
    mode?: unknown;
    bind?: unknown;
    port?: unknown;
    authMode?: unknown;
    tailscale?: unknown;
  };
  channels?: {
    count: number;
    ids: string[];
  };
  plugins?: {
    count: number;
    ids: string[];
  };
  agents?: {
    count: number;
  };
};

type ConfigExport = {
  shape: ConfigShape;
  sanitized?: unknown;
};

type SanitizedLogTail = {
  file: string;
  cursor: number;
  size: number;
  lineCount: number;
  truncated: boolean;
  reset: boolean;
  lines: Array<Record<string, unknown>>;
};

type SupportSnapshotStatus =
  | {
      status: "included";
      path: string;
    }
  | {
      status: "failed";
      path: string;
      error: string;
    }
  | {
      status: "skipped";
    };

type CollectedSupportSnapshot = {
  summary: SupportSnapshotStatus;
  file?: DiagnosticSupportExportFile;
};

function formatExportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function jsonFile(pathName: string, value: unknown): DiagnosticSupportExportFile {
  return {
    path: pathName,
    mediaType: "application/json",
    content: `${JSON.stringify(value, null, 2)}\n`,
  };
}

function textFile(pathName: string, content: string): DiagnosticSupportExportFile {
  return {
    path: pathName,
    mediaType: "text/plain; charset=utf-8",
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function safeScalar(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactTextForSupport(value);
    return redacted === value && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : "<redacted>";
  }
  return undefined;
}

function sortedObjectKeys(value: unknown): string[] {
  return Object.keys(asRecord(value) ?? {}).toSorted((a, b) => a.localeCompare(b));
}

function sanitizeConfigShape(parsed: unknown, configPath: string, stat: fs.Stats): ConfigShape {
  const root = asRecord(parsed) ?? {};
  const gateway = asRecord(root.gateway);
  const auth = asRecord(gateway?.auth);
  const channels = asRecord(root.channels);
  const plugins = asRecord(root.plugins);
  const agents = Array.isArray(root.agents) ? root.agents : undefined;

  const shape: ConfigShape = {
    path: configPath,
    exists: true,
    parseOk: true,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    topLevelKeys: sortedObjectKeys(root),
  };

  if (gateway) {
    shape.gateway = {
      mode: safeScalar(gateway.mode),
      bind: safeScalar(gateway.bind),
      port: safeScalar(gateway.port),
      authMode: safeScalar(auth?.mode),
      tailscale: safeScalar(gateway.tailscale),
    };
  }

  if (channels) {
    shape.channels = {
      count: Object.keys(channels).length,
      ids: sortedObjectKeys(channels),
    };
  }

  if (plugins) {
    shape.plugins = {
      count: Object.keys(plugins).length,
      ids: sortedObjectKeys(plugins),
    };
  }

  if (agents) {
    shape.agents = { count: agents.length };
  }

  return shape;
}

function sanitizeConfigDetails(parsed: unknown, redaction: SupportRedactionContext): unknown {
  return sanitizeSupportConfigValue(redactConfigObject(parsed), redaction);
}

function configShapeReadFailure(params: {
  configPath: string;
  stat?: fs.Stats;
  error?: string;
}): ConfigShape {
  const shape: ConfigShape = {
    path: params.configPath,
    exists: Boolean(params.stat),
    parseOk: false,
    topLevelKeys: [],
  };
  if (params.stat) {
    shape.bytes = params.stat.size;
    shape.mtime = params.stat.mtime.toISOString();
  }
  if (params.error) {
    shape.error = redactTextForSupport(params.error);
  }
  return shape;
}

function readConfigExport(options: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): ConfigExport {
  const redactedConfigPath = redactPathForSupport(options.configPath, options);
  const stat = fs.existsSync(options.configPath) ? fs.statSync(options.configPath) : null;
  if (!stat) {
    return {
      shape: configShapeReadFailure({ configPath: redactedConfigPath }),
    };
  }
  try {
    const parsed = parseConfigJson5(fs.readFileSync(options.configPath, "utf8"));
    if (!parsed.ok) {
      return {
        shape: configShapeReadFailure({
          configPath: redactedConfigPath,
          stat,
          error: parsed.error,
        }),
      };
    }
    return {
      shape: sanitizeConfigShape(parsed.parsed, redactedConfigPath, stat),
      sanitized: sanitizeConfigDetails(parsed.parsed, options),
    };
  } catch (error) {
    return {
      shape: configShapeReadFailure({
        configPath: redactedConfigPath,
        stat,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

function redactErrorForSupport(error: unknown): string {
  return redactTextForSupport(error instanceof Error ? error.message : String(error));
}

async function collectSupportSnapshot(params: {
  path: string;
  reader?: SupportSnapshotReader;
  generatedAt: string;
  redaction: SupportRedactionContext;
}): Promise<CollectedSupportSnapshot> {
  if (!params.reader) {
    return { summary: { status: "skipped" } };
  }
  try {
    const data = await params.reader();
    return {
      summary: {
        status: "included",
        path: params.path,
      },
      file: jsonFile(params.path, {
        status: "ok",
        capturedAt: params.generatedAt,
        data: sanitizeSupportSnapshotValue(data, params.redaction),
      }),
    };
  } catch (error) {
    const redactedError = redactErrorForSupport(error);
    return {
      summary: {
        status: "failed",
        path: params.path,
        error: redactedError,
      },
      file: jsonFile(params.path, {
        status: "failed",
        capturedAt: params.generatedAt,
        error: redactedError,
      }),
    };
  }
}

function readStabilityBundle(
  target: DiagnosticSupportExportOptions["stabilityBundle"],
  stateDir: string,
): ReadDiagnosticStabilityBundleResult {
  if (target === false) {
    return { status: "missing", dir: "$OPENCLAW_STATE_DIR/logs/stability" };
  }
  if (target === undefined || target === "latest") {
    return readLatestDiagnosticStabilityBundleSync({ stateDir });
  }
  return readDiagnosticStabilityBundleFileSync(target);
}

function sanitizeLogRecord(
  line: string,
  redaction: SupportRedactionContext,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      omitted: "unparsed",
      bytes: byteLength(line),
    };
  }

  const source = asRecord(parsed);
  if (!source) {
    return {
      omitted: "non-object",
      bytes: byteLength(line),
    };
  }

  const sanitized: Record<string, unknown> = {};
  addNamedLogFields(sanitized, source, redaction);
  addLogTapeMetaFields(sanitized, source, redaction);
  addLogTapeArgFields(sanitized, source, redaction);

  return Object.keys(sanitized).length > 0
    ? sanitized
    : {
        omitted: "no-safe-fields",
        bytes: byteLength(line),
      };
}

function addNamedLogFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === LOGTAPE_META_FIELD || LOGTAPE_ARG_FIELD_RE.test(key)) {
      continue;
    }
    addSafeLogField(sanitized, key, value, redaction);
  }
}

function addLogTapeMetaFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  const meta = asRecord(source[LOGTAPE_META_FIELD]);
  if (!meta) {
    return;
  }
  for (const [sourceKey, outputKey] of LOGTAPE_META_STRING_FIELDS) {
    if (sanitized[outputKey] !== undefined) {
      continue;
    }
    const value = meta[sourceKey];
    if (typeof value === "string") {
      if (sourceKey === "name") {
        const record = parseJsonRecord(value);
        if (record) {
          addLogObjectFields(sanitized, record, redaction);
          continue;
        }
      }
      sanitized[outputKey] = sanitizeLogString(value, redaction);
    }
  }
}

function addLogTapeArgFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  const args = Object.entries(source)
    .filter(([key]) => LOGTAPE_ARG_FIELD_RE.test(key))
    .toSorted(([left], [right]) => Number(left) - Number(right));

  for (const [, value] of args) {
    const record = typeof value === "string" ? parseJsonRecord(value) : asRecord(value);
    if (record) {
      addLogObjectFields(sanitized, record, redaction);
      continue;
    }

    if (typeof value === "string") {
      addLogTapeMessageField(sanitized, value, redaction);
    }
  }
}

function addLogTapeMessageField(
  sanitized: Record<string, unknown>,
  value: string,
  redaction: SupportRedactionContext,
): void {
  const message = sanitizeLogString(value, redaction);
  if (sanitized.msg === undefined && message && !UNSAFE_LOG_MESSAGE_RE.test(message)) {
    sanitized.msg = message;
    return;
  }
  addOmittedLogMessageMetadata(sanitized, value);
}

function addOmittedLogMessageMetadata(sanitized: Record<string, unknown>, value: string): void {
  sanitized.omitted = "log-message";
  sanitized.omittedLogMessageBytes =
    numericLogMetadata(sanitized.omittedLogMessageBytes) + byteLength(value);
  sanitized.omittedLogMessageCount = numericLogMetadata(sanitized.omittedLogMessageCount) + 1;
}

function numericLogMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function addLogObjectFields(
  sanitized: Record<string, unknown>,
  source: Record<string, unknown>,
  redaction: SupportRedactionContext,
): void {
  for (const [key, value] of Object.entries(source)) {
    addSafeLogField(sanitized, key, value, redaction);
  }
}

function addSafeLogField(
  sanitized: Record<string, unknown>,
  key: string,
  value: unknown,
  redaction: SupportRedactionContext,
): void {
  if (OMITTED_LOG_FIELD_RE.test(key)) {
    return;
  }
  if (!isSafeLogField(key, value)) {
    return;
  }
  if (typeof value === "string") {
    sanitized[key] = sanitizeLogString(value, redaction);
  } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
    sanitized[key] = value;
  }
}

function sanitizeLogString(value: string, redaction: SupportRedactionContext): string {
  return redactSupportString(value, redaction, {
    maxLength: MAX_LOG_STRING_LENGTH,
    truncationSuffix: "",
  });
}

function isSafeLogField(key: string, value: unknown): boolean {
  if (typeof value === "string") {
    return LOG_STRING_FIELD_RE.test(key);
  }
  return LOG_STRING_FIELD_RE.test(key) || LOG_SCALAR_FIELD_RE.test(key);
}

function sanitizeLogTail(tail: LogTailPayload, options: SupportRedactionContext): SanitizedLogTail {
  return {
    file: redactPathForSupport(tail.file, options),
    cursor: tail.cursor,
    size: tail.size,
    lineCount: tail.lines.length,
    truncated: tail.truncated,
    reset: tail.reset,
    lines: tail.lines.map((line) => sanitizeLogRecord(line, options)),
  };
}

function describeStabilityForDiagnostics(
  stability: ReadDiagnosticStabilityBundleResult,
  redaction: SupportRedactionContext,
) {
  if (stability.status === "found") {
    return {
      status: "found" as const,
      path: redactPathForSupport(stability.path, redaction),
      mtimeMs: stability.mtimeMs,
      eventCount: stability.bundle.snapshot.count,
      reason: stability.bundle.reason,
      generatedAt: stability.bundle.generatedAt,
    };
  }

  if (stability.status === "missing") {
    return {
      status: "missing" as const,
      dir: redactPathForSupport(stability.dir, redaction),
    };
  }

  return {
    status: "failed" as const,
    path: stability.path ? redactPathForSupport(stability.path, redaction) : undefined,
    error: redactErrorForSupport(stability.error),
  };
}

function renderSummary(params: {
  generatedAt: string;
  stability: ReadDiagnosticStabilityBundleResult;
  logTail: SanitizedLogTail;
  config: ConfigShape;
  status: SupportSnapshotStatus;
  health: SupportSnapshotStatus;
}): string {
  const stabilityLine =
    params.stability.status === "found"
      ? `included latest stability bundle (${params.stability.bundle.snapshot.count} event(s))`
      : `no stability bundle included (${params.stability.status})`;
  const configLine = params.config.exists
    ? `config shape included (${params.config.parseOk ? "parsed" : "parse failed"})`
    : "config file not found";
  const supportSnapshotLine = (label: string, snapshot: SupportSnapshotStatus) => {
    if (snapshot.status === "included") {
      return `${label} snapshot included (${snapshot.path})`;
    }
    if (snapshot.status === "failed") {
      return `${label} snapshot failed (${snapshot.error})`;
    }
    return `${label} snapshot skipped`;
  };
  return [
    "# OpenClaw Diagnostics Export",
    "",
    "Attach this zip to the bug report. It is designed for maintainers to inspect without asking for raw logs first.",
    "",
    "## Generated",
    "",
    `Generated: ${params.generatedAt}`,
    `OpenClaw: ${VERSION}`,
    "",
    "## Contents",
    "",
    `- ${stabilityLine}`,
    `- sanitized log tail (${params.logTail.lineCount} line(s), inspected ${params.logTail.size} byte(s), raw messages omitted)`,
    `- ${configLine}`,
    `- ${supportSnapshotLine("gateway status", params.status)}`,
    `- ${supportSnapshotLine("gateway health", params.health)}`,
    "",
    "## Maintainer Quick Read",
    "",
    "- `manifest.json`: file inventory and privacy notes",
    "- `diagnostics.json`: top-level summary of config, logs, stability, status, and health",
    "- `config/sanitized.json`: config values with credentials, private identifiers, and prompt text redacted",
    "- `status/gateway-status.json`: sanitized service/connectivity snapshot",
    "- `health/gateway-health.json`: sanitized Gateway health snapshot",
    "- `logs/openclaw-sanitized.jsonl`: sanitized log summaries and metadata",
    "- `stability/latest.json`: newest payload-free stability bundle, when available",
    "",
    "## Privacy",
    "",
    "- raw chat text, webhook bodies, tool outputs, tokens, cookies, and secrets are not included intentionally",
    "- log records keep operational summaries and safe metadata fields",
    "- status and health snapshots redact secret fields, payload-like fields, and account/message identifiers",
    "- config output keeps useful settings but redacts secrets, private identifiers, and prompt text",
  ].join("\n");
}

function defaultOutputPath(options: { now: Date; stateDir: string }): string {
  return path.join(
    options.stateDir,
    "logs",
    "support",
    `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`,
  );
}

function resolveOutputPath(options: {
  outputPath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  now: Date;
}): string {
  const raw = options.outputPath?.trim();
  if (!raw) {
    return defaultOutputPath(options);
  }
  const resolved =
    path.isAbsolute(raw) || raw.startsWith("~")
      ? resolveHomeRelativePath(raw, { env: options.env })
      : path.resolve(options.cwd, raw);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(
        resolved,
        `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`,
      );
    }
  } catch {
    // Non-existing output paths are treated as files.
  }
  return resolved;
}

export async function buildDiagnosticSupportExport(
  options: DiagnosticSupportExportOptions = {},
): Promise<DiagnosticSupportExportArtifact> {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const configPath = resolveConfigPath(env, stateDir);
  const stability = readStabilityBundle(options.stabilityBundle, stateDir);
  const redaction = { env, stateDir };
  const tail = await (options.readLogTail ?? readConfiguredLogTail)({
    limit: normalizePositiveInteger(options.logLimit, DEFAULT_LOG_LIMIT),
    maxBytes: normalizePositiveInteger(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES),
  });
  const logTail = sanitizeLogTail(tail, redaction);
  const config = readConfigExport({ configPath, env, stateDir });
  const [statusSnapshot, healthSnapshot] = await Promise.all([
    collectSupportSnapshot({
      path: "status/gateway-status.json",
      reader: options.readStatusSnapshot,
      generatedAt,
      redaction,
    }),
    collectSupportSnapshot({
      path: "health/gateway-health.json",
      reader: options.readHealthSnapshot,
      generatedAt,
      redaction,
    }),
  ]);
  const diagnostics = {
    generatedAt,
    openclawVersion: VERSION,
    process: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      pid: process.pid,
    },
    stateDir: redactPathForSupport(stateDir, redaction),
    config: config.shape,
    logs: {
      file: logTail.file,
      cursor: logTail.cursor,
      size: logTail.size,
      lineCount: logTail.lineCount,
      truncated: logTail.truncated,
      reset: logTail.reset,
    },
    stability: describeStabilityForDiagnostics(stability, redaction),
    status: statusSnapshot.summary,
    health: healthSnapshot.summary,
  };
  const files: DiagnosticSupportExportFile[] = [
    jsonFile("diagnostics.json", diagnostics),
    jsonFile("config/shape.json", config.shape),
    jsonFile("config/sanitized.json", config.sanitized ?? null),
    {
      path: "logs/openclaw-sanitized.jsonl",
      mediaType: "application/x-ndjson",
      content: logTail.lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    },
  ];
  for (const snapshot of [statusSnapshot, healthSnapshot]) {
    if (snapshot.file) {
      files.push(snapshot.file);
    }
  }

  if (stability.status === "found") {
    files.push(jsonFile("stability/latest.json", stability.bundle));
  }

  files.push(
    textFile(
      "summary.md",
      renderSummary({
        generatedAt,
        stability,
        logTail,
        config: config.shape,
        status: statusSnapshot.summary,
        health: healthSnapshot.summary,
      }),
    ),
  );

  const manifest: DiagnosticSupportExportManifest = {
    version: DIAGNOSTIC_SUPPORT_EXPORT_VERSION,
    generatedAt,
    openclawVersion: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    stateDir: redactPathForSupport(stateDir, redaction),
    contents: files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      bytes: byteLength(file.content),
    })),
    privacy: {
      payloadFree: true,
      rawLogsIncluded: false,
      notes: [
        "Stability bundles are payload-free diagnostic snapshots.",
        "Logs keep operational summaries and safe metadata fields; payload-like fields are omitted.",
        "Status and health snapshots redact secrets, payload-like fields, and account/message identifiers.",
        "Config output includes useful settings with credentials, private identifiers, and prompt text redacted.",
      ],
    },
  };

  return {
    manifest,
    files: [jsonFile("manifest.json", manifest), ...files],
  };
}

export async function writeDiagnosticSupportExport(
  options: DiagnosticSupportExportOptions = {},
): Promise<WriteDiagnosticSupportExportResult> {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const now = options.now ?? new Date();
  const outputPath = resolveOutputPath({
    outputPath: options.outputPath,
    cwd: options.cwd ?? process.cwd(),
    env,
    stateDir,
    now,
  });
  const artifact = await buildDiagnosticSupportExport({ ...options, env, stateDir, now });
  const zip = new JSZip();
  for (const file of artifact.files) {
    zip.file(file.path, file.content);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, buffer, { mode: 0o600 });
  return {
    path: outputPath,
    bytes: buffer.length,
    manifest: artifact.manifest,
  };
}

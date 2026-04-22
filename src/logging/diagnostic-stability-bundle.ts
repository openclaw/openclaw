import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveStateDir } from "../config/paths.js";
import { registerFatalErrorHook } from "../infra/fatal-error-hooks.js";
import {
  getDiagnosticStabilitySnapshot,
  MAX_DIAGNOSTIC_STABILITY_LIMIT,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

export const DIAGNOSTIC_STABILITY_BUNDLE_VERSION = 1;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT = MAX_DIAGNOSTIC_STABILITY_LIMIT;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION = 20;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BUNDLE_PREFIX = "openclaw-stability-";
const BUNDLE_SUFFIX = ".json";
const REDACTED_HOSTNAME = "<redacted-hostname>";

export type DiagnosticStabilityBundle = {
  version: typeof DIAGNOSTIC_STABILITY_BUNDLE_VERSION;
  generatedAt: string;
  reason: string;
  process: {
    pid: number;
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    uptimeMs: number;
  };
  host: {
    hostname: string;
  };
  error?: {
    name?: string;
    code?: string;
  };
  snapshot: DiagnosticStabilitySnapshot;
};

export type WriteDiagnosticStabilityBundleResult =
  | { status: "written"; path: string; bundle: DiagnosticStabilityBundle }
  | { status: "skipped"; reason: "empty" }
  | { status: "failed"; error: unknown };

export type WriteDiagnosticStabilityBundleOptions = {
  reason: string;
  error?: unknown;
  includeEmpty?: boolean;
  limit?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  retention?: number;
};

export type DiagnosticStabilityBundleLocationOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

export type DiagnosticStabilityBundleFile = {
  path: string;
  mtimeMs: number;
};

export type ReadDiagnosticStabilityBundleResult =
  | { status: "found"; path: string; mtimeMs: number; bundle: DiagnosticStabilityBundle }
  | { status: "missing"; dir: string }
  | { status: "failed"; path?: string; error: unknown };

export type DiagnosticStabilityBundleFailureWriteOutcome =
  | { status: "written"; message: string; path: string }
  | { status: "failed"; message: string; error: unknown }
  | { status: "skipped"; reason: "empty" };

export type WriteDiagnosticStabilityBundleForFailureOptions = Omit<
  WriteDiagnosticStabilityBundleOptions,
  "error" | "includeEmpty" | "reason"
>;

let fatalHookUnsubscribe: (() => void) | null = null;

function normalizeReason(reason: string): string {
  return SAFE_REASON_CODE.test(reason) ? reason : "unknown";
}

function formatBundleTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && SAFE_REASON_CODE.test(code)) {
    return code;
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  return undefined;
}

function readErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && SAFE_REASON_CODE.test(name) ? name : undefined;
}

function readSafeErrorMetadata(error: unknown): DiagnosticStabilityBundle["error"] | undefined {
  const name = readErrorName(error);
  const code = readErrorCode(error);
  if (!name && !code) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
  };
}

export function resolveDiagnosticStabilityBundleDir(
  options: DiagnosticStabilityBundleLocationOptions = {},
): string {
  return path.join(
    options.stateDir ?? resolveStateDir(options.env ?? process.env),
    "logs",
    "stability",
  );
}

function buildBundlePath(dir: string, now: Date, reason: string): string {
  return path.join(
    dir,
    `${BUNDLE_PREFIX}${formatBundleTimestamp(now)}-${process.pid}-${normalizeReason(reason)}${BUNDLE_SUFFIX}`,
  );
}

function isBundleFile(name: string): boolean {
  return name.startsWith(BUNDLE_PREFIX) && name.endsWith(BUNDLE_SUFFIX);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid stability bundle: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseDiagnosticStabilityBundle(value: unknown): DiagnosticStabilityBundle {
  const bundle = readObject(value, "bundle");
  if (bundle.version !== DIAGNOSTIC_STABILITY_BUNDLE_VERSION) {
    throw new Error(`Unsupported stability bundle version: ${String(bundle.version)}`);
  }
  if (typeof bundle.generatedAt !== "string" || typeof bundle.reason !== "string") {
    throw new Error("Invalid stability bundle: missing generatedAt or reason");
  }
  readObject(bundle.process, "process");
  readObject(bundle.host, "host");
  const snapshot = readObject(bundle.snapshot, "snapshot");
  if (!Array.isArray(snapshot.events) || typeof snapshot.summary !== "object") {
    throw new Error("Invalid stability bundle: snapshot is malformed");
  }
  return bundle as DiagnosticStabilityBundle;
}

export function listDiagnosticStabilityBundleFilesSync(
  options: DiagnosticStabilityBundleLocationOptions = {},
): DiagnosticStabilityBundleFile[] {
  const dir = resolveDiagnosticStabilityBundleDir(options);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isBundleFile(entry.name))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        return {
          path: file,
          mtimeMs: fs.statSync(file).mtimeMs,
        };
      })
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

export function readDiagnosticStabilityBundleFileSync(
  file: string,
): ReadDiagnosticStabilityBundleResult {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const bundle = parseDiagnosticStabilityBundle(JSON.parse(raw));
    return {
      status: "found",
      path: file,
      mtimeMs: fs.statSync(file).mtimeMs,
      bundle,
    };
  } catch (error) {
    return { status: "failed", path: file, error };
  }
}

export function readLatestDiagnosticStabilityBundleSync(
  options: DiagnosticStabilityBundleLocationOptions = {},
): ReadDiagnosticStabilityBundleResult {
  try {
    const latest = listDiagnosticStabilityBundleFilesSync(options)[0];
    if (!latest) {
      return {
        status: "missing",
        dir: resolveDiagnosticStabilityBundleDir(options),
      };
    }
    return readDiagnosticStabilityBundleFileSync(latest.path);
  } catch (error) {
    return { status: "failed", error };
  }
}

function pruneOldBundles(dir: string, retention: number): void {
  if (!Number.isFinite(retention) || retention < 1) {
    return;
  }
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isBundleFile(entry.name))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          // Missing files are ignored below.
        }
        return { file, mtimeMs };
      })
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));

    for (const entry of entries.slice(retention)) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // Retention cleanup must not block failure handling.
      }
    }
  } catch {
    // Retention cleanup must not block failure handling.
  }
}

export function writeDiagnosticStabilityBundleSync(
  options: WriteDiagnosticStabilityBundleOptions,
): WriteDiagnosticStabilityBundleResult {
  try {
    const now = options.now ?? new Date();
    const snapshot = getDiagnosticStabilitySnapshot({
      limit: options.limit ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT,
    });
    if (!options.includeEmpty && snapshot.count === 0) {
      return { status: "skipped", reason: "empty" };
    }

    const reason = normalizeReason(options.reason);
    const error = options.error ? readSafeErrorMetadata(options.error) : undefined;
    const bundle: DiagnosticStabilityBundle = {
      version: DIAGNOSTIC_STABILITY_BUNDLE_VERSION,
      generatedAt: now.toISOString(),
      reason,
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        uptimeMs: Math.round(process.uptime() * 1000),
      },
      host: {
        hostname: REDACTED_HOSTNAME,
      },
      ...(error ? { error } : {}),
      snapshot,
    };

    const dir = resolveDiagnosticStabilityBundleDir(options);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = buildBundlePath(dir, now, reason);
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(bundle, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpFile, file);
    pruneOldBundles(dir, options.retention ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION);
    return { status: "written", path: file, bundle };
  } catch (error) {
    return { status: "failed", error };
  }
}

export function writeDiagnosticStabilityBundleForFailureSync(
  reason: string,
  error?: unknown,
  options: WriteDiagnosticStabilityBundleForFailureOptions = {},
): DiagnosticStabilityBundleFailureWriteOutcome {
  const result = writeDiagnosticStabilityBundleSync({
    ...options,
    reason,
    error,
    includeEmpty: false,
  });
  if (result.status === "written") {
    return {
      status: "written",
      path: result.path,
      message: `wrote stability bundle: ${result.path}`,
    };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error,
      message: `failed to write stability bundle: ${String(result.error)}`,
    };
  }
  return result;
}

export function installDiagnosticStabilityFatalHook(
  options: WriteDiagnosticStabilityBundleForFailureOptions = {},
): void {
  if (fatalHookUnsubscribe) {
    return;
  }
  fatalHookUnsubscribe = registerFatalErrorHook(({ reason, error }) => {
    const result = writeDiagnosticStabilityBundleForFailureSync(reason, error, options);
    return "message" in result ? result.message : undefined;
  });
}

export function uninstallDiagnosticStabilityFatalHook(): void {
  fatalHookUnsubscribe?.();
  fatalHookUnsubscribe = null;
}

export function resetDiagnosticStabilityBundleForTest(): void {
  uninstallDiagnosticStabilityFatalHook();
}

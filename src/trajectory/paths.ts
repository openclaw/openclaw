// Trajectory path helpers resolve storage paths for trajectory artifacts.
import fs from "node:fs";
import path from "node:path";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";

// Runtime trajectory path helpers. Paths are either beside the session file or
// inside OPENCLAW_TRAJECTORY_DIR, with names scrubbed for filesystem safety.
export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;

const DEFAULT_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;

/**
 * Resolve the per-event byte cap for trajectory runtime events.
 *
 * Operators can override the 256 KiB default via the
 * `OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES` environment variable. Values
 * accept human-friendly suffixes (`512kb`, `2mb`, `1gb`) or raw byte counts
 * (`262144`). Invalid, empty, or non-positive values fall back to the default
 * so misconfiguration cannot silently widen truncation behavior.
 */
export function resolveTrajectoryRuntimeEventMaxBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES?.trim();
  if (!raw) {
    return DEFAULT_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES;
  }
  try {
    const parsed = parseTrajectoryEventByteSize(raw);
    if (parsed > 0) {
      return parsed;
    }
  } catch {
    // Fall through to default on invalid input.
  }
  return DEFAULT_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES;
}

/**
 * Minimal byte-size parser for the trajectory event cap env var.
 * Supports: raw integers, `kb`, `mb`, `gb` suffixes.
 */
function parseTrajectoryEventByteSize(raw: string): number {
  const lower = raw.toLowerCase().replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(lower);
  if (!m) {
    throw new Error(`invalid byte size: ${raw}`);
  }
  const [, numStr, unit] = m;
  const num = Number.parseFloat(numStr);
  switch (unit) {
    case "kb":
    case "k":
      return Math.floor(num * 1024);
    case "mb":
    case "m":
      return Math.floor(num * 1024 * 1024);
    case "gb":
    case "g":
      return Math.floor(num * 1024 * 1024 * 1024);
    case "":
    case "b":
      return Math.floor(num);
    default:
      throw new Error(`invalid byte size unit: ${unit}`);
  }
}

export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = resolveTrajectoryRuntimeEventMaxBytes();

type TrajectoryPointerOpenFlagConstants = Pick<
  typeof fs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

// Pointer files are overwritten atomically by callers. O_NOFOLLOW is optional
// because some platforms do not expose it, but use it when Node provides it.
export function resolveTrajectoryPointerOpenFlags(
  constants: TrajectoryPointerOpenFlagConstants = fs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  if (resolvedFile === resolvedBase || !isPathInside(resolvedBase, resolvedFile)) {
    throw new Error("Trajectory file path escaped its configured directory");
  }
  return resolvedFile;
}

export function resolveTrajectoryFilePath(params: {
  env?: NodeJS.ProcessEnv;
  sessionFile?: string;
  sessionId: string;
}): string {
  const env = params.env ?? process.env;
  const dirOverride = env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return resolveContainedPath(
      resolveHomeRelativePath(dirOverride),
      `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`,
    );
  }
  if (!params.sessionFile) {
    return path.join(
      process.cwd(),
      `${safeTrajectorySessionFileName(params.sessionId)}.trajectory.jsonl`,
    );
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

// Sidecar pointer naming contract used to discover runtime trace files from a
// persisted session file during support-bundle export.
export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}

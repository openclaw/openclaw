// Workspace disk health probe for gateway readiness.
// Periodically tests that critical workspace/state paths are writable so
// /readyz reports not-ready when the workspace PVC is full (ENOSPC) or
// otherwise not writable.
import fs from "node:fs";
import path from "node:path";

/** Health probe result for workspace disk writability. */
export type WorkspaceDiskHealthResult = {
  ok: boolean;
  reason?: string;
};

const DEFAULT_PROBE_TTL_MS = 30_000;
const HEALTH_PROBE_FILENAME = ".openclaw-readiness-probe";

/** Create a cached workspace disk health probe.
 *
 *  The probe writes a small file + fsync + unlink under a designated probe
 *  directory (default: a subdirectory of the first writable config/home
 *  path). If the write fails with ENOSPC, EROFS, or EACCES the probe
 *  reports not-ok. The result is cached for `ttlMs` so repeated /readyz
 *  calls stay cheap.
 */
export function createWorkspaceDiskHealthProbe(deps: {
  probeDir?: string;
  ttlMs?: number;
}): () => WorkspaceDiskHealthResult {
  const ttlMs = deps.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const probeDir = deps.probeDir ?? resolveDefaultProbeDir();

  let cachedAt = 0;
  let cachedResult: WorkspaceDiskHealthResult = { ok: true };

  // Ensure the probe directory exists.
  try {
    fs.mkdirSync(probeDir, { recursive: true });
  } catch {
    // Best-effort; the first probe will report the error.
  }

  return (): WorkspaceDiskHealthResult => {
    const now = Date.now();
    if (cachedAt > 0 && now - cachedAt < ttlMs) {
      return cachedResult;
    }

    try {
      const probePath = path.join(probeDir, HEALTH_PROBE_FILENAME);
      const fd = fs.openSync(probePath, "w");
      try {
        fs.writeSync(fd, "", 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(probePath);
      cachedResult = { ok: true };
    } catch (error: unknown) {
      const cause =
        error && typeof error === "object" && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      switch (cause) {
        case "ENOSPC":
          cachedResult = { ok: false, reason: "workspace-disk-full" };
          break;
        case "EROFS":
          cachedResult = { ok: false, reason: "workspace-readonly-fs" };
          break;
        case "EACCES":
          cachedResult = { ok: false, reason: "workspace-permission-denied" };
          break;
        case "ENOENT":
          cachedResult = { ok: false, reason: "workspace-missing-probe-dir" };
          break;
        default:
          // EMFILE, network mount timeouts, and other transient failures
          // do not flip readiness. Only persistent failures above do.
          break;
      }
    }

    cachedAt = now;
    return cachedResult;
  };
}

function resolveDefaultProbeDir(): string {
  // Walk known config/home paths and use the first writable directory.
  const candidates = [
    process.env.OPENCLAW_CONFIG_ROOT,
    process.env.OPENCLAW_HOME,
    process.env.HOME,
    process.env.XDG_CONFIG_HOME,
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const probeDir = path.join(dir, ".openclaw", ".health");
      fs.mkdirSync(probeDir, { recursive: true });
      return probeDir;
    } catch {
      continue;
    }
  }
  return path.join(process.cwd(), ".openclaw", ".health");
}

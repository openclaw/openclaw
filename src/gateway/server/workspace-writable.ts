// Gateway workspace writability probe for readiness checks.
// Used by createReadinessChecker to detect ENOSPC / read-only / permission
// failures so that /readyz reports NotReady when the persistent workspace
// cannot accept writes — see issue #96084.
import fs from "node:fs";
import path from "node:path";

const PROBE_FILE_NAME = ".openclaw-readyz-probe";
const PROBE_DATA = "readyz\n";
const PROBE_CACHE_TTL_MS = 30_000;

type WorkspaceWritableResult =
  | { writable: true }
  | { writable: false; failing: string };

export type WorkspaceWritableChecker = () => WorkspaceWritableResult;

function diskErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as Record<string, unknown>).code;
  if (typeof code !== "string") {
    return undefined;
  }
  if (code === "ENOSPC") {
    return "workspace-enospc";
  }
  if (code === "EROFS") {
    return "workspace-readonly";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "workspace-permission";
  }
  return undefined;
}

/**
 * Create a cached workspace-writable checker.
 *
 * The probe writes a small temp file, syncs, and deletes it in the
 * nominated directory.  Results are cached so /readyz stays cheap even
 * under load.  Only `ENOSPC`, `EROFS`, `EACCES`, and `EPERM` cause a
 * non-writable result — other transient I/O errors are logged but do
 * not affect readiness.
 */
export function createWorkspaceWritableChecker(
  workspaceDir: string,
  opts?: { cacheTtlMs?: number },
): WorkspaceWritableChecker {
  if (!workspaceDir) {
    // No workspace dir means no probe; report writable so readiness isn't
    // blocked by the absence of a probe target.
    return () => ({ writable: true });
  }
  const cacheTtlMs = opts?.cacheTtlMs ?? PROBE_CACHE_TTL_MS;
  let cachedAt = 0;
  let cachedResult: WorkspaceWritableResult = { writable: true };

  return (): WorkspaceWritableResult => {
    const now = Date.now();
    if (now - cachedAt < cacheTtlMs) {
      return cachedResult;
    }
    cachedAt = now;

    const probePath = path.join(workspaceDir, PROBE_FILE_NAME);
    try {
      fs.writeFileSync(probePath, PROBE_DATA, { flag: "w" });
      fs.rmSync(probePath, { force: true });
      cachedResult = { writable: true };
      return cachedResult;
    } catch (err) {
      const reason = diskErrorCode(err);
      if (reason) {
        cachedResult = { writable: false, failing: reason };
      } else {
        // Transient non-disk error (e.g. EEXIST race) — keep last known
        // state so a single hiccup doesn't flip readiness.
        // probe file cleanup is best-effort.
        try {
          fs.rmSync(probePath, { force: true });
        } catch {
          // ignore cleanup errors
        }
      }
      return cachedResult;
    }
  };
}

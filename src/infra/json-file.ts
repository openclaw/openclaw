import fs from "node:fs";
import path from "node:path";

/**
 * Load a JSON file from disk.
 *
 * If the primary file is missing or corrupt (e.g. truncated by a crash during
 * a previous write), the function transparently falls back to the `.bak`
 * backup that {@link saveJsonFile} creates before every write.  This makes
 * auth-profiles.json (and any other JSON state file) resilient to process
 * termination during writes — see openclaw/openclaw#23931.
 */
export function loadJsonFile(pathname: string): unknown {
  const result = tryParseJsonFile(pathname);
  if (result !== undefined) {
    return result;
  }

  // Primary file missing or corrupt — try the backup.
  const backupPath = `${pathname}.bak`;
  const backup = tryParseJsonFile(backupPath);
  if (backup !== undefined) {
    // We intentionally do NOT write the backup back to the primary file here.
    // Callers such as the auth-profiles store wrap their writes in
    // `withFileLock`; a bare `writeFileSync` here would bypass that lock and
    // could race with a concurrent `saveJsonFile` call.  Instead we return the
    // backup data as-is — the next regular (lock-safe, atomic) `saveJsonFile`
    // will recreate a healthy primary file automatically.
    return backup;
  }

  return undefined;
}

function tryParseJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    if (raw.trim().length === 0) {
      return undefined;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Atomically save a JSON file to disk.
 *
 * 1. Back up the current file to `<pathname>.bak` (if it exists).
 * 2. Write the new content to a temporary file (`<pathname>.tmp`).
 * 3. Rename the temp file over the target — rename is atomic on POSIX and
 *    effectively atomic on NTFS.
 *
 * This prevents data loss when the process is killed mid-write (e.g. gateway
 * restart via SIGTERM from a LaunchAgent) — fixes openclaw/openclaw#23931.
 */
export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = `${pathname}.tmp`;
  const backupPath = `${pathname}.bak`;

  // 1. Back up the current file (best-effort).
  try {
    if (fs.existsSync(pathname)) {
      fs.copyFileSync(pathname, backupPath);
    }
  } catch {
    // Non-critical: if backup fails we still proceed with the atomic write.
  }

  // 2. Write to temp file.
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // chmod may fail on some platforms; non-critical.
  }

  // 3. Atomic rename over the target.
  fs.renameSync(tmpPath, pathname);
}

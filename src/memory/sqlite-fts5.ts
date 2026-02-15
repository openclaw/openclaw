import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Attempt to load the FTS5 loadable extension if FTS5 is not already
 * compiled into Node's built-in SQLite.
 *
 * Resolution order for the extension binary:
 *   1. Explicit `extensionPath` parameter
 *   2. `OPENCLAW_FTS5_PATH` environment variable
 *   3. `vendor/sqlite-extensions/fts5.so` relative to project root
 *   4. `/usr/local/lib/fts5.so` system path
 *
 * Returns `{ ok: true }` when FTS5 is available (either built-in or loaded),
 * or `{ ok: false, error }` when it cannot be made available.
 */
export function loadFts5Extension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): { ok: boolean; extensionPath?: string; error?: string } {
  // Quick check: is FTS5 already available?
  if (isFts5Available(params.db)) {
    return { ok: true };
  }

  // Try loading it as an extension
  const candidates = buildCandidatePaths(params.extensionPath);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      params.db.enableLoadExtension(true);
      params.db.loadExtension(candidate);
      params.db.enableLoadExtension(false);
      return { ok: true, extensionPath: candidate };
    } catch {
      // Try next candidate
    }
  }

  return {
    ok: false,
    error: `fts5 extension not found (searched: ${candidates.join(", ")})`,
  };
}

function isFts5Available(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)");
    db.exec("DROP TABLE IF EXISTS _fts5_probe");
    return true;
  } catch {
    return false;
  }
}

function buildCandidatePaths(explicit?: string): string[] {
  const candidates: string[] = [];

  // 1. Explicit path
  if (explicit?.trim()) {
    candidates.push(explicit.trim());
  }

  // 2. Environment variable
  const envPath = process.env.OPENCLAW_FTS5_PATH;
  if (envPath?.trim()) {
    candidates.push(envPath.trim());
  }

  // 3. Relative to bundle output directory
  //    At runtime __dirname is dist/ (bundled), project root is ../
  const fromBundle = path.resolve(__dirname, "..", "vendor", "sqlite-extensions", "fts5.so");
  candidates.push(fromBundle);

  // 4. Relative to source directory (dev mode: src/memory/ → ../../vendor)
  const fromSource = path.resolve(__dirname, "..", "..", "vendor", "sqlite-extensions", "fts5.so");
  if (fromSource !== fromBundle) {
    candidates.push(fromSource);
  }

  // 5. Relative to cwd (fallback)
  const cwdPath = path.resolve(process.cwd(), "vendor", "sqlite-extensions", "fts5.so");
  if (cwdPath !== fromBundle && cwdPath !== fromSource) {
    candidates.push(cwdPath);
  }

  // 6. System fallback
  candidates.push("/usr/local/lib/fts5.so");

  return candidates;
}

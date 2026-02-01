import { isBunRuntime, type SqliteDatabase } from "./sqlite.js";

export async function loadSqliteVecExtension(params: {
  db: SqliteDatabase;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await import("sqlite-vec");
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    // Node's DatabaseSync requires enabling extension loading first
    // Bun's Database doesn't have this method and allows extensions by default
    if (!isBunRuntime && "enableLoadExtension" in params.db) {
      params.db.enableLoadExtension(true);
    }

    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

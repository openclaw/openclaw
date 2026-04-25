import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type SqliteVecModule = {
  getLoadablePath: () => string;
  load: (db: DatabaseSync) => void;
};

const SQLITE_VEC_MODULE_ID = "sqlite-vec";
let sqliteVecModulePromise: Promise<SqliteVecModule> | null = null;

async function loadSqliteVecModule(): Promise<SqliteVecModule> {
  sqliteVecModulePromise ??= (import(SQLITE_VEC_MODULE_ID) as Promise<SqliteVecModule>).catch(
    (err) => {
      sqliteVecModulePromise = null;
      throw new Error(
        "sqlite-vec package is not installed; configure memory.store.vector.extensionPath or install sqlite-vec to enable local vector search",
        { cause: err },
      );
    },
  );
  return sqliteVecModulePromise;
}

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const resolvedPath = normalizeOptionalString(params.extensionPath);
    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      params.db.loadExtension(resolvedPath);
      return { ok: true, extensionPath: resolvedPath };
    }

    const sqliteVec = await loadSqliteVecModule();
    const extensionPath = sqliteVec.getLoadablePath();
    sqliteVec.load(params.db);
    return { ok: true, extensionPath };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, error: message };
  }
}

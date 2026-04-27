import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
const SQLITE_VEC_MODULE_ID = "sqlite-vec";
let sqliteVecModulePromise = null;
async function loadSqliteVecModule() {
    sqliteVecModulePromise ??= import(SQLITE_VEC_MODULE_ID);
    return sqliteVecModulePromise;
}
export async function loadSqliteVecExtension(params) {
    try {
        const sqliteVec = await loadSqliteVecModule();
        const resolvedPath = normalizeOptionalString(params.extensionPath);
        const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();
        params.db.enableLoadExtension(true);
        if (resolvedPath) {
            params.db.loadExtension(extensionPath);
        }
        else {
            sqliteVec.load(params.db);
        }
        return { ok: true, extensionPath };
    }
    catch (err) {
        const message = formatErrorMessage(err);
        return { ok: false, error: message };
    }
}

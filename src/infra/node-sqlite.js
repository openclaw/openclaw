import { createRequire } from "node:module";
import { formatErrorMessage } from "./errors.js";
import { installProcessWarningFilter } from "./warning-filter.js";
const require = createRequire(import.meta.url);
export function requireNodeSqlite() {
    installProcessWarningFilter();
    try {
        return require("node:sqlite");
    }
    catch (err) {
        const message = formatErrorMessage(err);
        throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
    }
}

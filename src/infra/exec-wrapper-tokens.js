import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com"];
function stripWindowsExecutableSuffix(value) {
    for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
        if (value.endsWith(suffix)) {
            return value.slice(0, -suffix.length);
        }
    }
    return value;
}
export function basenameLower(token) {
    const win = path.win32.basename(token);
    const posix = path.posix.basename(token);
    const base = win.length < posix.length ? win : posix;
    return normalizeLowercaseStringOrEmpty(base);
}
export function normalizeExecutableToken(token) {
    return stripWindowsExecutableSuffix(basenameLower(token));
}

import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function buildNodeShellCommand(command, platform) {
    const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
    if (normalized.startsWith("win")) {
        return ["cmd.exe", "/d", "/s", "/c", command];
    }
    return ["/bin/sh", "-lc", command];
}

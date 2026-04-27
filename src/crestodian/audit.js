import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
export function resolveCrestodianAuditPath(env = process.env, stateDir = resolveStateDir(env)) {
    return path.join(stateDir, "audit", "crestodian.jsonl");
}
export async function appendCrestodianAuditEntry(entry, opts = {}) {
    const auditPath = opts.auditPath ?? resolveCrestodianAuditPath(opts.env);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
    });
    await fs.appendFile(auditPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(auditPath, 0o600).catch(() => {
        // Best-effort on platforms/filesystems without POSIX modes.
    });
    return auditPath;
}

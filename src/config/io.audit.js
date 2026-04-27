import path from "node:path";
import { resolveStateDir } from "./paths.js";
const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
function normalizeAuditLabel(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function resolveConfigAuditProcessInfo(processInfo) {
    if (processInfo) {
        return processInfo;
    }
    return {
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        argv: process.argv.slice(0, 8),
        execArgv: process.execArgv.slice(0, 8),
    };
}
export function resolveConfigAuditLogPath(env, homedir) {
    return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}
export function formatConfigOverwriteLogMessage(params) {
    const changeSummary = typeof params.changedPathCount === "number" ? `, changedPaths=${params.changedPathCount}` : "";
    return `Config overwrite: ${params.configPath} (sha256 ${params.previousHash ?? "unknown"} -> ${params.nextHash}, backup=${params.configPath}.bak${changeSummary})`;
}
export function createConfigWriteAuditRecordBase(params) {
    const processSnapshot = resolveConfigAuditProcessInfo(params.processInfo);
    return {
        ts: params.now ?? new Date().toISOString(),
        source: "config-io",
        event: "config.write",
        configPath: params.configPath,
        pid: processSnapshot.pid,
        ppid: processSnapshot.ppid,
        cwd: processSnapshot.cwd,
        argv: processSnapshot.argv,
        execArgv: processSnapshot.execArgv,
        watchMode: params.env.OPENCLAW_WATCH_MODE === "1",
        watchSession: normalizeAuditLabel(params.env.OPENCLAW_WATCH_SESSION),
        watchCommand: normalizeAuditLabel(params.env.OPENCLAW_WATCH_COMMAND),
        existsBefore: params.existsBefore,
        previousHash: params.previousHash,
        nextHash: params.nextHash,
        previousBytes: params.previousBytes,
        nextBytes: params.nextBytes,
        previousDev: params.previousMetadata.dev,
        previousIno: params.previousMetadata.ino,
        previousMode: params.previousMetadata.mode,
        previousNlink: params.previousMetadata.nlink,
        previousUid: params.previousMetadata.uid,
        previousGid: params.previousMetadata.gid,
        changedPathCount: typeof params.changedPathCount === "number" ? params.changedPathCount : null,
        hasMetaBefore: params.hasMetaBefore,
        hasMetaAfter: params.hasMetaAfter,
        gatewayModeBefore: params.gatewayModeBefore,
        gatewayModeAfter: params.gatewayModeAfter,
        suspicious: params.suspicious,
    };
}
export function finalizeConfigWriteAuditRecord(params) {
    const errorCode = params.err &&
        typeof params.err === "object" &&
        "code" in params.err &&
        typeof params.err.code === "string"
        ? params.err.code
        : undefined;
    const errorMessage = params.err &&
        typeof params.err === "object" &&
        "message" in params.err &&
        typeof params.err.message === "string"
        ? params.err.message
        : undefined;
    const nextMetadata = params.nextMetadata ?? {
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
    };
    const success = params.result !== "failed" && params.result !== "rejected";
    return {
        ...params.base,
        result: params.result,
        nextHash: success ? params.base.nextHash : null,
        nextBytes: success ? params.base.nextBytes : null,
        nextDev: success ? nextMetadata.dev : null,
        nextIno: success ? nextMetadata.ino : null,
        nextMode: success ? nextMetadata.mode : null,
        nextNlink: success ? nextMetadata.nlink : null,
        nextUid: success ? nextMetadata.uid : null,
        nextGid: success ? nextMetadata.gid : null,
        errorCode,
        errorMessage,
    };
}
function resolveConfigAuditAppendRecord(params) {
    if ("record" in params) {
        return params.record;
    }
    const { fs: _fs, env: _env, homedir: _homedir, ...record } = params;
    return record;
}
export async function appendConfigAuditRecord(params) {
    try {
        const auditPath = resolveConfigAuditLogPath(params.env, params.homedir);
        const record = resolveConfigAuditAppendRecord(params);
        await params.fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
        await params.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    }
    catch {
        // best-effort
    }
}
export function appendConfigAuditRecordSync(params) {
    try {
        const auditPath = resolveConfigAuditLogPath(params.env, params.homedir);
        const record = resolveConfigAuditAppendRecord(params);
        params.fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
        params.fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    }
    catch {
        // best-effort
    }
}

import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "../utils.js";
import { appendConfigAuditRecord, appendConfigAuditRecordSync, } from "./io.audit.js";
import { resolveStateDir } from "./paths.js";
import { isPluginLocalInvalidConfigSnapshot, shouldAttemptLastKnownGoodRecovery, } from "./recovery-policy.js";
function createConfigObserveAuditRecord(params) {
    return {
        ts: params.ts,
        source: "config-io",
        event: "config.observe",
        phase: "read",
        configPath: params.configPath,
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        argv: process.argv.slice(0, 8),
        execArgv: process.execArgv.slice(0, 8),
        exists: true,
        valid: params.valid,
        hash: params.current.hash,
        bytes: params.current.bytes,
        mtimeMs: params.current.mtimeMs,
        ctimeMs: params.current.ctimeMs,
        dev: params.current.dev,
        ino: params.current.ino,
        mode: params.current.mode,
        nlink: params.current.nlink,
        uid: params.current.uid,
        gid: params.current.gid,
        hasMeta: params.current.hasMeta,
        gatewayMode: params.current.gatewayMode,
        suspicious: params.suspicious,
        lastKnownGoodHash: params.lastKnownGood?.hash ?? null,
        lastKnownGoodBytes: params.lastKnownGood?.bytes ?? null,
        lastKnownGoodMtimeMs: params.lastKnownGood?.mtimeMs ?? null,
        lastKnownGoodCtimeMs: params.lastKnownGood?.ctimeMs ?? null,
        lastKnownGoodDev: params.lastKnownGood?.dev ?? null,
        lastKnownGoodIno: params.lastKnownGood?.ino ?? null,
        lastKnownGoodMode: params.lastKnownGood?.mode ?? null,
        lastKnownGoodNlink: params.lastKnownGood?.nlink ?? null,
        lastKnownGoodUid: params.lastKnownGood?.uid ?? null,
        lastKnownGoodGid: params.lastKnownGood?.gid ?? null,
        lastKnownGoodGatewayMode: params.lastKnownGood?.gatewayMode ?? null,
        backupHash: params.backup?.hash ?? null,
        backupBytes: params.backup?.bytes ?? null,
        backupMtimeMs: params.backup?.mtimeMs ?? null,
        backupCtimeMs: params.backup?.ctimeMs ?? null,
        backupDev: params.backup?.dev ?? null,
        backupIno: params.backup?.ino ?? null,
        backupMode: params.backup?.mode ?? null,
        backupNlink: params.backup?.nlink ?? null,
        backupUid: params.backup?.uid ?? null,
        backupGid: params.backup?.gid ?? null,
        backupGatewayMode: params.backup?.gatewayMode ?? null,
        clobberedPath: params.clobberedPath,
        restoredFromBackup: params.restoredFromBackup,
        restoredBackupPath: params.restoredBackupPath,
    };
}
function createConfigObserveAuditAppendParams(deps, params) {
    return {
        fs: deps.fs,
        env: deps.env,
        homedir: deps.homedir,
        record: createConfigObserveAuditRecord(params),
    };
}
function createConfigObserveAnomalyAuditAppendParams(deps, params) {
    return createConfigObserveAuditAppendParams(deps, {
        ...params,
        restoredFromBackup: false,
        restoredBackupPath: null,
    });
}
function hashConfigRaw(raw) {
    return crypto
        .createHash("sha256")
        .update(raw ?? "")
        .digest("hex");
}
function resolveConfigSnapshotHash(snapshot) {
    if (typeof snapshot.hash === "string") {
        const trimmed = snapshot.hash.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    if (typeof snapshot.raw !== "string") {
        return null;
    }
    return hashConfigRaw(snapshot.raw);
}
function hasConfigMeta(value) {
    return (isRecord(value) &&
        isRecord(value.meta) &&
        (typeof value.meta.lastTouchedVersion === "string" ||
            typeof value.meta.lastTouchedAt === "string"));
}
function resolveGatewayMode(value) {
    if (!isRecord(value) || !isRecord(value.gateway)) {
        return null;
    }
    return typeof value.gateway.mode === "string" ? value.gateway.mode : null;
}
function resolveConfigStatMetadata(stat) {
    if (!stat) {
        return {
            dev: null,
            ino: null,
            mode: null,
            nlink: null,
            uid: null,
            gid: null,
        };
    }
    return {
        dev: typeof stat.dev === "number" || typeof stat.dev === "bigint" ? String(stat.dev) : null,
        ino: typeof stat.ino === "number" || typeof stat.ino === "bigint" ? String(stat.ino) : null,
        mode: typeof stat.mode === "number" ? stat.mode : null,
        nlink: typeof stat.nlink === "number" ? stat.nlink : null,
        uid: typeof stat.uid === "number" ? stat.uid : null,
        gid: typeof stat.gid === "number" ? stat.gid : null,
    };
}
function createConfigHealthFingerprint(params) {
    return {
        hash: params.hash,
        bytes: Buffer.byteLength(params.raw, "utf-8"),
        mtimeMs: params.stat?.mtimeMs ?? null,
        ctimeMs: params.stat?.ctimeMs ?? null,
        ...resolveConfigStatMetadata(params.stat),
        hasMeta: hasConfigMeta(params.parsed),
        gatewayMode: resolveGatewayMode(params.gatewaySource),
        observedAt: params.observedAt,
    };
}
function parseConfigRawOrEmpty(deps, raw) {
    try {
        return deps.json5.parse(raw);
    }
    catch {
        return {};
    }
}
function resolveConfigHealthStatePath(env, homedir) {
    return path.join(resolveStateDir(env, homedir), "logs", "config-health.json");
}
async function readConfigHealthState(deps) {
    try {
        const raw = await deps.fs.promises.readFile(resolveConfigHealthStatePath(deps.env, deps.homedir), "utf-8");
        const parsed = deps.json5.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function readConfigHealthStateSync(deps) {
    try {
        const raw = deps.fs.readFileSync(resolveConfigHealthStatePath(deps.env, deps.homedir), "utf-8");
        const parsed = deps.json5.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
async function writeConfigHealthState(deps, state) {
    try {
        const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
        await deps.fs.promises.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
        await deps.fs.promises.writeFile(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    }
    catch { }
}
function writeConfigHealthStateSync(deps, state) {
    try {
        const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
        deps.fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
        deps.fs.writeFileSync(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    }
    catch { }
}
function getConfigHealthEntry(state, configPath) {
    const entries = state.entries;
    if (!entries || !isRecord(entries)) {
        return {};
    }
    const entry = entries[configPath];
    return entry && isRecord(entry) ? entry : {};
}
function setConfigHealthEntry(state, configPath, entry) {
    return {
        ...state,
        entries: {
            ...state.entries,
            [configPath]: entry,
        },
    };
}
function createLastObservedSuspiciousEntry(entry, suspiciousSignature) {
    return {
        ...entry,
        lastObservedSuspiciousSignature: suspiciousSignature,
    };
}
function isUpdateChannelOnlyRoot(value) {
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "update") {
        return false;
    }
    const update = value.update;
    if (!isRecord(update)) {
        return false;
    }
    const updateKeys = Object.keys(update);
    return updateKeys.length === 1 && typeof update.channel === "string";
}
function resolveConfigObserveSuspiciousReasons(params) {
    const reasons = [];
    const baseline = params.lastKnownGood;
    if (!baseline) {
        return reasons;
    }
    if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
        reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
    }
    if (baseline.hasMeta && !params.hasMeta) {
        reasons.push("missing-meta-vs-last-good");
    }
    if (baseline.gatewayMode && !params.gatewayMode) {
        reasons.push("gateway-mode-missing-vs-last-good");
    }
    if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
        reasons.push("update-channel-only-root");
    }
    return reasons;
}
function resolveSuspiciousSignature(current, suspicious) {
    return `${current.hash}:${suspicious.join(",")}`;
}
function isRecoverableConfigReadSuspiciousReason(reason) {
    return (reason === "missing-meta-vs-last-good" ||
        reason === "gateway-mode-missing-vs-last-good" ||
        reason === "update-channel-only-root" ||
        reason.startsWith("size-drop-vs-last-good:"));
}
function resolveConfigReadRecoveryContext(params) {
    const suspicious = resolveConfigObserveSuspiciousReasons({
        bytes: params.current.bytes,
        hasMeta: params.current.hasMeta,
        gatewayMode: params.current.gatewayMode,
        parsed: params.parsed,
        lastKnownGood: params.backupBaseline,
    });
    if (!suspicious.some(isRecoverableConfigReadSuspiciousReason)) {
        return null;
    }
    const suspiciousSignature = resolveSuspiciousSignature(params.current, suspicious);
    if (params.entry.lastObservedSuspiciousSignature === suspiciousSignature) {
        return null;
    }
    return { suspicious, suspiciousSignature };
}
async function readConfigFingerprintForPath(deps, targetPath) {
    try {
        const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
        const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
        const parsed = parseConfigRawOrEmpty(deps, raw);
        return createConfigHealthFingerprint({
            hash: hashConfigRaw(raw),
            raw,
            parsed,
            gatewaySource: parsed,
            stat: stat,
            observedAt: new Date().toISOString(),
        });
    }
    catch {
        return null;
    }
}
function readConfigFingerprintForPathSync(deps, targetPath) {
    try {
        const raw = deps.fs.readFileSync(targetPath, "utf-8");
        const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
        const parsed = parseConfigRawOrEmpty(deps, raw);
        return createConfigHealthFingerprint({
            hash: hashConfigRaw(raw),
            raw,
            parsed,
            gatewaySource: parsed,
            stat,
            observedAt: new Date().toISOString(),
        });
    }
    catch {
        return null;
    }
}
function formatConfigArtifactTimestamp(ts) {
    return ts.replaceAll(":", "-").replaceAll(".", "-");
}
export function resolveLastKnownGoodConfigPath(configPath) {
    return `${configPath}.last-good`;
}
function isSensitiveConfigPath(pathLabel) {
    return /(^|\.)(api[-_]?key|auth|bearer|credential|password|private[-_]?key|secret|token)(\.|$)/i.test(pathLabel);
}
function collectPollutedSecretPlaceholders(value, pathLabel = "", output = []) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "***" || trimmed === "[redacted]") {
            output.push(pathLabel || "<root>");
            return output;
        }
        if (isSensitiveConfigPath(pathLabel) && (trimmed.includes("...") || trimmed.includes("…"))) {
            output.push(pathLabel || "<root>");
        }
        return output;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectPollutedSecretPlaceholders(item, `${pathLabel}[${index}]`, output));
        return output;
    }
    if (isRecord(value)) {
        for (const [key, child] of Object.entries(value)) {
            const childPath = pathLabel ? `${pathLabel}.${key}` : key;
            collectPollutedSecretPlaceholders(child, childPath, output);
        }
    }
    return output;
}
async function persistClobberedConfigSnapshot(params) {
    const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
    try {
        await params.deps.fs.promises.writeFile(targetPath, params.raw, {
            encoding: "utf-8",
            mode: 0o600,
            flag: "wx",
        });
        return targetPath;
    }
    catch {
        return null;
    }
}
function persistClobberedConfigSnapshotSync(params) {
    const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
    try {
        params.deps.fs.writeFileSync(targetPath, params.raw, {
            encoding: "utf-8",
            mode: 0o600,
            flag: "wx",
        });
        return targetPath;
    }
    catch {
        return null;
    }
}
export async function maybeRecoverSuspiciousConfigRead(params) {
    const stat = await params.deps.fs.promises.stat(params.configPath).catch(() => null);
    const now = new Date().toISOString();
    const current = createConfigHealthFingerprint({
        hash: hashConfigRaw(params.raw),
        raw: params.raw,
        parsed: params.parsed,
        gatewaySource: params.parsed,
        stat: stat,
        observedAt: now,
    });
    let healthState = await readConfigHealthState(params.deps);
    const entry = getConfigHealthEntry(healthState, params.configPath);
    const backupPath = `${params.configPath}.bak`;
    const backupBaseline = entry.lastKnownGood ??
        (await readConfigFingerprintForPath(params.deps, backupPath)) ??
        undefined;
    const recoveryContext = resolveConfigReadRecoveryContext({
        current,
        parsed: params.parsed,
        entry,
        backupBaseline,
    });
    if (!recoveryContext) {
        return { raw: params.raw, parsed: params.parsed };
    }
    const { suspicious, suspiciousSignature } = recoveryContext;
    const backupRaw = await params.deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null);
    if (!backupRaw) {
        return { raw: params.raw, parsed: params.parsed };
    }
    let backupParsed;
    try {
        backupParsed = params.deps.json5.parse(backupRaw);
    }
    catch {
        return { raw: params.raw, parsed: params.parsed };
    }
    const backup = backupBaseline ?? (await readConfigFingerprintForPath(params.deps, backupPath));
    if (!backup?.gatewayMode) {
        return { raw: params.raw, parsed: params.parsed };
    }
    const clobberedPath = await persistClobberedConfigSnapshot({
        deps: params.deps,
        configPath: params.configPath,
        raw: params.raw,
        observedAt: now,
    });
    let restoredFromBackup = false;
    try {
        await params.deps.fs.promises.copyFile(backupPath, params.configPath);
        restoredFromBackup = true;
    }
    catch { }
    params.deps.logger.warn(`Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`);
    await appendConfigAuditRecord(createConfigObserveAuditAppendParams(params.deps, {
        ts: now,
        configPath: params.configPath,
        valid: true,
        current,
        suspicious,
        lastKnownGood: entry.lastKnownGood,
        backup,
        clobberedPath,
        restoredFromBackup,
        restoredBackupPath: backupPath,
    }));
    healthState = setConfigHealthEntry(healthState, params.configPath, createLastObservedSuspiciousEntry(entry, suspiciousSignature));
    await writeConfigHealthState(params.deps, healthState);
    return { raw: backupRaw, parsed: backupParsed };
}
export function maybeRecoverSuspiciousConfigReadSync(params) {
    const stat = params.deps.fs.statSync(params.configPath, { throwIfNoEntry: false }) ?? null;
    const now = new Date().toISOString();
    const current = createConfigHealthFingerprint({
        hash: hashConfigRaw(params.raw),
        raw: params.raw,
        parsed: params.parsed,
        gatewaySource: params.parsed,
        stat,
        observedAt: now,
    });
    let healthState = readConfigHealthStateSync(params.deps);
    const entry = getConfigHealthEntry(healthState, params.configPath);
    const backupPath = `${params.configPath}.bak`;
    const backupBaseline = entry.lastKnownGood ?? readConfigFingerprintForPathSync(params.deps, backupPath) ?? undefined;
    const recoveryContext = resolveConfigReadRecoveryContext({
        current,
        parsed: params.parsed,
        entry,
        backupBaseline,
    });
    if (!recoveryContext) {
        return { raw: params.raw, parsed: params.parsed };
    }
    const { suspicious, suspiciousSignature } = recoveryContext;
    let backupRaw;
    try {
        backupRaw = params.deps.fs.readFileSync(backupPath, "utf-8");
    }
    catch {
        return { raw: params.raw, parsed: params.parsed };
    }
    let backupParsed;
    try {
        backupParsed = params.deps.json5.parse(backupRaw);
    }
    catch {
        return { raw: params.raw, parsed: params.parsed };
    }
    const backup = backupBaseline ?? readConfigFingerprintForPathSync(params.deps, backupPath);
    if (!backup?.gatewayMode) {
        return { raw: params.raw, parsed: params.parsed };
    }
    const clobberedPath = persistClobberedConfigSnapshotSync({
        deps: params.deps,
        configPath: params.configPath,
        raw: params.raw,
        observedAt: now,
    });
    let restoredFromBackup = false;
    try {
        params.deps.fs.copyFileSync(backupPath, params.configPath);
        restoredFromBackup = true;
    }
    catch { }
    params.deps.logger.warn(`Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`);
    appendConfigAuditRecordSync(createConfigObserveAuditAppendParams(params.deps, {
        ts: now,
        configPath: params.configPath,
        valid: true,
        current,
        suspicious,
        lastKnownGood: entry.lastKnownGood,
        backup,
        clobberedPath,
        restoredFromBackup,
        restoredBackupPath: backupPath,
    }));
    healthState = setConfigHealthEntry(healthState, params.configPath, createLastObservedSuspiciousEntry(entry, suspiciousSignature));
    writeConfigHealthStateSync(params.deps, healthState);
    return { raw: backupRaw, parsed: backupParsed };
}
export async function observeConfigSnapshot(deps, snapshot) {
    if (!snapshot.exists || typeof snapshot.raw !== "string") {
        return;
    }
    const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
    const now = new Date().toISOString();
    const current = createConfigHealthFingerprint({
        hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
        raw: snapshot.raw,
        parsed: snapshot.parsed,
        gatewaySource: snapshot.resolved,
        stat: stat,
        observedAt: now,
    });
    let healthState = await readConfigHealthState(deps);
    const entry = getConfigHealthEntry(healthState, snapshot.path);
    const backupBaseline = entry.lastKnownGood ??
        (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`)) ??
        undefined;
    const suspicious = resolveConfigObserveSuspiciousReasons({
        bytes: current.bytes,
        hasMeta: current.hasMeta,
        gatewayMode: current.gatewayMode,
        parsed: snapshot.parsed,
        lastKnownGood: backupBaseline,
    });
    if (suspicious.length === 0) {
        if (snapshot.valid) {
            const nextEntry = {
                ...entry,
                lastKnownGood: current,
                lastObservedSuspiciousSignature: null,
            };
            const same = entry.lastKnownGood &&
                entry.lastKnownGood.hash === current.hash &&
                entry.lastKnownGood.bytes === current.bytes &&
                entry.lastKnownGood.mtimeMs === current.mtimeMs &&
                entry.lastKnownGood.ctimeMs === current.ctimeMs &&
                entry.lastKnownGood.dev === current.dev &&
                entry.lastKnownGood.ino === current.ino &&
                entry.lastKnownGood.mode === current.mode &&
                entry.lastKnownGood.nlink === current.nlink &&
                entry.lastKnownGood.uid === current.uid &&
                entry.lastKnownGood.gid === current.gid &&
                entry.lastKnownGood.hasMeta === current.hasMeta &&
                entry.lastKnownGood.gatewayMode === current.gatewayMode;
            if (!same || entry.lastObservedSuspiciousSignature !== null) {
                healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
                await writeConfigHealthState(deps, healthState);
            }
        }
        return;
    }
    const suspiciousSignature = resolveSuspiciousSignature(current, suspicious);
    if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
        return;
    }
    const backup = (backupBaseline?.hash ? backupBaseline : null) ??
        (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`));
    const clobberedPath = await persistClobberedConfigSnapshot({
        deps,
        configPath: snapshot.path,
        raw: snapshot.raw,
        observedAt: now,
    });
    deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
    await appendConfigAuditRecord(createConfigObserveAnomalyAuditAppendParams(deps, {
        ts: now,
        configPath: snapshot.path,
        valid: snapshot.valid,
        current,
        suspicious,
        lastKnownGood: entry.lastKnownGood,
        backup,
        clobberedPath,
    }));
    healthState = setConfigHealthEntry(healthState, snapshot.path, createLastObservedSuspiciousEntry(entry, suspiciousSignature));
    await writeConfigHealthState(deps, healthState);
}
export function observeConfigSnapshotSync(deps, snapshot) {
    if (!snapshot.exists || typeof snapshot.raw !== "string") {
        return;
    }
    const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
    const now = new Date().toISOString();
    const current = createConfigHealthFingerprint({
        hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
        raw: snapshot.raw,
        parsed: snapshot.parsed,
        gatewaySource: snapshot.resolved,
        stat,
        observedAt: now,
    });
    let healthState = readConfigHealthStateSync(deps);
    const entry = getConfigHealthEntry(healthState, snapshot.path);
    const backupBaseline = entry.lastKnownGood ??
        readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`) ??
        undefined;
    const suspicious = resolveConfigObserveSuspiciousReasons({
        bytes: current.bytes,
        hasMeta: current.hasMeta,
        gatewayMode: current.gatewayMode,
        parsed: snapshot.parsed,
        lastKnownGood: backupBaseline,
    });
    if (suspicious.length === 0) {
        if (snapshot.valid) {
            healthState = setConfigHealthEntry(healthState, snapshot.path, {
                ...entry,
                lastKnownGood: current,
                lastObservedSuspiciousSignature: null,
            });
            writeConfigHealthStateSync(deps, healthState);
        }
        return;
    }
    const suspiciousSignature = resolveSuspiciousSignature(current, suspicious);
    if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
        return;
    }
    const backup = (backupBaseline?.hash ? backupBaseline : null) ??
        readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
    const clobberedPath = persistClobberedConfigSnapshotSync({
        deps,
        configPath: snapshot.path,
        raw: snapshot.raw,
        observedAt: now,
    });
    deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
    appendConfigAuditRecordSync(createConfigObserveAnomalyAuditAppendParams(deps, {
        ts: now,
        configPath: snapshot.path,
        valid: snapshot.valid,
        current,
        suspicious,
        lastKnownGood: entry.lastKnownGood,
        backup,
        clobberedPath,
    }));
    healthState = setConfigHealthEntry(healthState, snapshot.path, createLastObservedSuspiciousEntry(entry, suspiciousSignature));
    writeConfigHealthStateSync(deps, healthState);
}
export async function promoteConfigSnapshotToLastKnownGood(params) {
    const { deps, snapshot } = params;
    if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
        return false;
    }
    const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
    if (polluted.length > 0) {
        params.logger?.warn(`Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`);
        return false;
    }
    const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
    const now = new Date().toISOString();
    const current = createConfigHealthFingerprint({
        hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
        raw: snapshot.raw,
        parsed: snapshot.parsed,
        gatewaySource: snapshot.resolved,
        stat: stat,
        observedAt: now,
    });
    const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
    await deps.fs.promises.writeFile(lastGoodPath, snapshot.raw, {
        encoding: "utf-8",
        mode: 0o600,
    });
    await deps.fs.promises.chmod?.(lastGoodPath, 0o600).catch(() => { });
    const healthState = await readConfigHealthState(deps);
    const entry = getConfigHealthEntry(healthState, snapshot.path);
    await writeConfigHealthState(deps, setConfigHealthEntry(healthState, snapshot.path, {
        ...entry,
        lastKnownGood: current,
        lastPromotedGood: current,
        lastObservedSuspiciousSignature: null,
    }));
    return true;
}
export async function recoverConfigFromLastKnownGood(params) {
    const { deps, snapshot } = params;
    if (!snapshot.exists || typeof snapshot.raw !== "string") {
        return false;
    }
    if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
        if (isPluginLocalInvalidConfigSnapshot(snapshot)) {
            deps.logger.warn(`Config last-known-good recovery skipped: invalidity is scoped to plugin entries (${params.reason})`);
        }
        return false;
    }
    const healthState = await readConfigHealthState(deps);
    const entry = getConfigHealthEntry(healthState, snapshot.path);
    const promoted = entry.lastPromotedGood;
    if (!promoted?.hash) {
        return false;
    }
    const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
    const backupRaw = await deps.fs.promises.readFile(lastGoodPath, "utf-8").catch(() => null);
    if (!backupRaw || hashConfigRaw(backupRaw) !== promoted.hash) {
        return false;
    }
    let backupParsed;
    try {
        backupParsed = deps.json5.parse(backupRaw);
    }
    catch {
        return false;
    }
    const polluted = collectPollutedSecretPlaceholders(backupParsed);
    if (polluted.length > 0) {
        deps.logger.warn(`Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`);
        return false;
    }
    const now = new Date().toISOString();
    const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
    const current = createConfigHealthFingerprint({
        hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
        raw: snapshot.raw,
        parsed: snapshot.parsed,
        gatewaySource: snapshot.resolved,
        stat: stat,
        observedAt: now,
    });
    const clobberedPath = await persistClobberedConfigSnapshot({
        deps,
        configPath: snapshot.path,
        raw: snapshot.raw,
        observedAt: now,
    });
    await deps.fs.promises.copyFile(lastGoodPath, snapshot.path);
    await deps.fs.promises.chmod?.(snapshot.path, 0o600).catch(() => { });
    deps.logger.warn(`Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})`);
    await appendConfigAuditRecord(createConfigObserveAuditAppendParams(deps, {
        ts: now,
        configPath: snapshot.path,
        valid: snapshot.valid,
        current,
        suspicious: [params.reason],
        lastKnownGood: promoted,
        backup: promoted,
        clobberedPath,
        restoredFromBackup: true,
        restoredBackupPath: lastGoodPath,
    }));
    await writeConfigHealthState(deps, setConfigHealthEntry(healthState, snapshot.path, {
        ...entry,
        lastKnownGood: promoted,
        lastPromotedGood: promoted,
        lastObservedSuspiciousSignature: null,
    }));
    return true;
}

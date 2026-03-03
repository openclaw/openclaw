import crypto from "node:crypto";
import { normalizeEnvVarKey } from "./host-env-security.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";
export function normalizeSystemRunApprovalPlan(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const candidate = value;
    const argv = normalizeStringArray(candidate.argv);
    if (argv.length === 0) {
        return null;
    }
    return {
        argv,
        cwd: normalizeNonEmptyString(candidate.cwd),
        rawCommand: normalizeNonEmptyString(candidate.rawCommand),
        agentId: normalizeNonEmptyString(candidate.agentId),
        sessionKey: normalizeNonEmptyString(candidate.sessionKey),
    };
}
function normalizeSystemRunEnvEntries(env) {
    if (!env || typeof env !== "object" || Array.isArray(env)) {
        return [];
    }
    const entries = [];
    for (const [rawKey, rawValue] of Object.entries(env)) {
        if (typeof rawValue !== "string") {
            continue;
        }
        const key = normalizeEnvVarKey(rawKey, { portable: true });
        if (!key) {
            continue;
        }
        entries.push([key, rawValue]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
}
function hashSystemRunEnvEntries(entries) {
    if (entries.length === 0) {
        return null;
    }
    return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
export function buildSystemRunApprovalEnvBinding(env) {
    const entries = normalizeSystemRunEnvEntries(env);
    return {
        envHash: hashSystemRunEnvEntries(entries),
        envKeys: entries.map(([key]) => key),
    };
}
export function buildSystemRunApprovalBinding(params) {
    const envBinding = buildSystemRunApprovalEnvBinding(params.env);
    return {
        binding: {
            argv: normalizeStringArray(params.argv),
            cwd: normalizeNonEmptyString(params.cwd),
            agentId: normalizeNonEmptyString(params.agentId),
            sessionKey: normalizeNonEmptyString(params.sessionKey),
            envHash: envBinding.envHash,
        },
        envKeys: envBinding.envKeys,
    };
}
function argvMatches(expectedArgv, actualArgv) {
    if (expectedArgv.length === 0 || expectedArgv.length !== actualArgv.length) {
        return false;
    }
    for (let i = 0; i < expectedArgv.length; i += 1) {
        if (expectedArgv[i] !== actualArgv[i]) {
            return false;
        }
    }
    return true;
}
const APPROVAL_REQUEST_MISMATCH_MESSAGE = "approval id does not match request";
function requestMismatch(details) {
    return {
        ok: false,
        code: "APPROVAL_REQUEST_MISMATCH",
        message: APPROVAL_REQUEST_MISMATCH_MESSAGE,
        details,
    };
}
export function matchSystemRunApprovalEnvHash(params) {
    if (!params.expectedEnvHash && !params.actualEnvHash) {
        return { ok: true };
    }
    if (!params.expectedEnvHash && params.actualEnvHash) {
        return {
            ok: false,
            code: "APPROVAL_ENV_BINDING_MISSING",
            message: "approval id missing env binding for requested env overrides",
            details: { envKeys: params.actualEnvKeys },
        };
    }
    if (params.expectedEnvHash !== params.actualEnvHash) {
        return {
            ok: false,
            code: "APPROVAL_ENV_MISMATCH",
            message: "approval id env binding mismatch",
            details: {
                envKeys: params.actualEnvKeys,
                expectedEnvHash: params.expectedEnvHash,
                actualEnvHash: params.actualEnvHash,
            },
        };
    }
    return { ok: true };
}
export function matchSystemRunApprovalBinding(params) {
    if (!argvMatches(params.expected.argv, params.actual.argv)) {
        return requestMismatch();
    }
    if (params.expected.cwd !== params.actual.cwd) {
        return requestMismatch();
    }
    if (params.expected.agentId !== params.actual.agentId) {
        return requestMismatch();
    }
    if (params.expected.sessionKey !== params.actual.sessionKey) {
        return requestMismatch();
    }
    return matchSystemRunApprovalEnvHash({
        expectedEnvHash: params.expected.envHash,
        actualEnvHash: params.actual.envHash,
        actualEnvKeys: params.actualEnvKeys,
    });
}
export function missingSystemRunApprovalBinding(params) {
    return requestMismatch({
        envKeys: params.actualEnvKeys,
    });
}
export function toSystemRunApprovalMismatchError(params) {
    const details = {
        code: params.match.code,
        runId: params.runId,
    };
    if (params.match.details) {
        Object.assign(details, params.match.details);
    }
    return {
        ok: false,
        message: params.match.message,
        details,
    };
}

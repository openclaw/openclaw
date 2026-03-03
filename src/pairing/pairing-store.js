import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { withFileLock as withPathLock } from "../infra/file-lock.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
const PAIRING_STORE_LOCK_OPTIONS = {
    retries: {
        retries: 10,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 10000,
        randomize: true,
    },
    stale: 30000,
};
function resolveCredentialsDir(env = process.env) {
    const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
    return resolveOAuthDir(env, stateDir);
}
/** Sanitize channel ID for use in filenames (prevent path traversal). */
function safeChannelKey(channel) {
    const raw = String(channel).trim().toLowerCase();
    if (!raw) {
        throw new Error("invalid pairing channel");
    }
    const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
    if (!safe || safe === "_") {
        throw new Error("invalid pairing channel");
    }
    return safe;
}
function resolvePairingPath(channel, env = process.env) {
    return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}
function safeAccountKey(accountId) {
    const raw = String(accountId).trim().toLowerCase();
    if (!raw) {
        throw new Error("invalid pairing account id");
    }
    const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
    if (!safe || safe === "_") {
        throw new Error("invalid pairing account id");
    }
    return safe;
}
function resolveAllowFromPath(channel, env = process.env, accountId) {
    const base = safeChannelKey(channel);
    const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
    if (!normalizedAccountId) {
        return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
    }
    return path.join(resolveCredentialsDir(env), `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`);
}
async function readJsonFile(filePath, fallback) {
    return await readJsonFileWithFallback(filePath, fallback);
}
async function writeJsonFile(filePath, value) {
    await writeJsonFileAtomically(filePath, value);
}
async function readPairingRequests(filePath) {
    const { value } = await readJsonFile(filePath, {
        version: 1,
        requests: [],
    });
    return Array.isArray(value.requests) ? value.requests : [];
}
async function readPrunedPairingRequests(filePath) {
    return pruneExpiredRequests(await readPairingRequests(filePath), Date.now());
}
async function ensureJsonFile(filePath, fallback) {
    try {
        await fs.promises.access(filePath);
    }
    catch {
        await writeJsonFile(filePath, fallback);
    }
}
async function withFileLock(filePath, fallback, fn) {
    await ensureJsonFile(filePath, fallback);
    return await withPathLock(filePath, PAIRING_STORE_LOCK_OPTIONS, async () => {
        return await fn();
    });
}
function parseTimestamp(value) {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return parsed;
}
function isExpired(entry, nowMs) {
    const createdAt = parseTimestamp(entry.createdAt);
    if (!createdAt) {
        return true;
    }
    return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}
function pruneExpiredRequests(reqs, nowMs) {
    const kept = [];
    let removed = false;
    for (const req of reqs) {
        if (isExpired(req, nowMs)) {
            removed = true;
            continue;
        }
        kept.push(req);
    }
    return { requests: kept, removed };
}
function resolveLastSeenAt(entry) {
    return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}
function pruneExcessRequests(reqs, maxPending) {
    if (maxPending <= 0 || reqs.length <= maxPending) {
        return { requests: reqs, removed: false };
    }
    const sorted = reqs.slice().toSorted((a, b) => resolveLastSeenAt(a) - resolveLastSeenAt(b));
    return { requests: sorted.slice(-maxPending), removed: true };
}
function randomCode() {
    // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
    let out = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
        const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
        out += PAIRING_CODE_ALPHABET[idx];
    }
    return out;
}
function generateUniqueCode(existing) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        const code = randomCode();
        if (!existing.has(code)) {
            return code;
        }
    }
    throw new Error("failed to generate unique pairing code");
}
function normalizePairingAccountId(accountId) {
    return accountId?.trim().toLowerCase() || "";
}
function requestMatchesAccountId(entry, normalizedAccountId) {
    if (!normalizedAccountId) {
        return true;
    }
    return (String(entry.meta?.accountId ?? "")
        .trim()
        .toLowerCase() === normalizedAccountId);
}
function shouldIncludeLegacyAllowFromEntries(normalizedAccountId) {
    // Keep backward compatibility for legacy channel-scoped allowFrom only on default account.
    // Non-default accounts should remain isolated to avoid cross-account implicit approvals.
    return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}
function resolveAllowFromAccountId(accountId) {
    return normalizePairingAccountId(accountId) || DEFAULT_ACCOUNT_ID;
}
function normalizeId(value) {
    return String(value).trim();
}
function normalizeAllowEntry(channel, entry) {
    const trimmed = entry.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed === "*") {
        return "";
    }
    const adapter = getPairingAdapter(channel);
    const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
    return String(normalized).trim();
}
function normalizeAllowFromList(channel, store) {
    const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
    return dedupePreserveOrder(list.map((v) => normalizeAllowEntry(channel, String(v))).filter(Boolean));
}
function normalizeAllowFromInput(channel, entry) {
    return normalizeAllowEntry(channel, normalizeId(entry));
}
function dedupePreserveOrder(entries) {
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
        const normalized = String(entry).trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
async function readAllowFromStateForPath(channel, filePath) {
    return (await readAllowFromStateForPathWithExists(channel, filePath)).entries;
}
async function readAllowFromStateForPathWithExists(channel, filePath) {
    const { value, exists } = await readJsonFile(filePath, {
        version: 1,
        allowFrom: [],
    });
    const entries = normalizeAllowFromList(channel, value);
    return { entries, exists };
}
function readAllowFromStateForPathSync(channel, filePath) {
    return readAllowFromStateForPathSyncWithExists(channel, filePath).entries;
}
function readAllowFromStateForPathSyncWithExists(channel, filePath) {
    let raw = "";
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return { entries: [], exists: false };
        }
        return { entries: [], exists: false };
    }
    try {
        const parsed = JSON.parse(raw);
        const entries = normalizeAllowFromList(channel, parsed);
        return { entries, exists: true };
    }
    catch {
        // Keep parity with async reads: malformed JSON still means the file exists.
        return { entries: [], exists: true };
    }
}
async function readAllowFromState(params) {
    const { value } = await readJsonFile(params.filePath, {
        version: 1,
        allowFrom: [],
    });
    const current = normalizeAllowFromList(params.channel, value);
    const normalized = normalizeAllowFromInput(params.channel, params.entry);
    return { current, normalized: normalized || null };
}
async function writeAllowFromState(filePath, allowFrom) {
    await writeJsonFile(filePath, {
        version: 1,
        allowFrom,
    });
}
async function readNonDefaultAccountAllowFrom(params) {
    const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
    return await readAllowFromStateForPath(params.channel, scopedPath);
}
function readNonDefaultAccountAllowFromSync(params) {
    const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
    return readAllowFromStateForPathSync(params.channel, scopedPath);
}
async function updateAllowFromStoreEntry(params) {
    const env = params.env ?? process.env;
    const filePath = resolveAllowFromPath(params.channel, env, params.accountId);
    return await withFileLock(filePath, { version: 1, allowFrom: [] }, async () => {
        const { current, normalized } = await readAllowFromState({
            channel: params.channel,
            entry: params.entry,
            filePath,
        });
        if (!normalized) {
            return { changed: false, allowFrom: current };
        }
        const next = params.apply(current, normalized);
        if (!next) {
            return { changed: false, allowFrom: current };
        }
        await writeAllowFromState(filePath, next);
        return { changed: true, allowFrom: next };
    });
}
export async function readLegacyChannelAllowFromStore(channel, env = process.env) {
    const filePath = resolveAllowFromPath(channel, env);
    return await readAllowFromStateForPath(channel, filePath);
}
export async function readChannelAllowFromStore(channel, env = process.env, accountId) {
    const resolvedAccountId = resolveAllowFromAccountId(accountId);
    if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
        return await readNonDefaultAccountAllowFrom({
            channel,
            env,
            accountId: resolvedAccountId,
        });
    }
    const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
    const scopedEntries = await readAllowFromStateForPath(channel, scopedPath);
    // Backward compatibility: legacy channel-level allowFrom store was unscoped.
    // Keep honoring it for default account to prevent re-pair prompts after upgrades.
    const legacyPath = resolveAllowFromPath(channel, env);
    const legacyEntries = await readAllowFromStateForPath(channel, legacyPath);
    return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
export function readLegacyChannelAllowFromStoreSync(channel, env = process.env) {
    const filePath = resolveAllowFromPath(channel, env);
    return readAllowFromStateForPathSync(channel, filePath);
}
export function readChannelAllowFromStoreSync(channel, env = process.env, accountId) {
    const resolvedAccountId = resolveAllowFromAccountId(accountId);
    if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
        return readNonDefaultAccountAllowFromSync({
            channel,
            env,
            accountId: resolvedAccountId,
        });
    }
    const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
    const scopedEntries = readAllowFromStateForPathSync(channel, scopedPath);
    const legacyPath = resolveAllowFromPath(channel, env);
    const legacyEntries = readAllowFromStateForPathSync(channel, legacyPath);
    return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
async function updateChannelAllowFromStore(params) {
    return await updateAllowFromStoreEntry({
        channel: params.channel,
        entry: params.entry,
        accountId: params.accountId,
        env: params.env,
        apply: params.apply,
    });
}
async function mutateChannelAllowFromStoreEntry(params, apply) {
    return await updateChannelAllowFromStore({
        ...params,
        apply,
    });
}
export async function addChannelAllowFromStoreEntry(params) {
    return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
        if (current.includes(normalized)) {
            return null;
        }
        return [...current, normalized];
    });
}
export async function removeChannelAllowFromStoreEntry(params) {
    return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
        const next = current.filter((entry) => entry !== normalized);
        if (next.length === current.length) {
            return null;
        }
        return next;
    });
}
export async function listChannelPairingRequests(channel, env = process.env, accountId) {
    const filePath = resolvePairingPath(channel, env);
    return await withFileLock(filePath, { version: 1, requests: [] }, async () => {
        const { requests: prunedExpired, removed: expiredRemoved } = await readPrunedPairingRequests(filePath);
        const { requests: pruned, removed: cappedRemoved } = pruneExcessRequests(prunedExpired, PAIRING_PENDING_MAX);
        if (expiredRemoved || cappedRemoved) {
            await writeJsonFile(filePath, {
                version: 1,
                requests: pruned,
            });
        }
        const normalizedAccountId = normalizePairingAccountId(accountId);
        const filtered = normalizedAccountId
            ? pruned.filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
            : pruned;
        return filtered
            .filter((r) => r &&
            typeof r.id === "string" &&
            typeof r.code === "string" &&
            typeof r.createdAt === "string")
            .slice()
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
}
export async function upsertChannelPairingRequest(params) {
    const env = params.env ?? process.env;
    const filePath = resolvePairingPath(params.channel, env);
    return await withFileLock(filePath, { version: 1, requests: [] }, async () => {
        const now = new Date().toISOString();
        const nowMs = Date.now();
        const id = normalizeId(params.id);
        const normalizedAccountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
        const baseMeta = params.meta && typeof params.meta === "object"
            ? Object.fromEntries(Object.entries(params.meta)
                .map(([k, v]) => [k, String(v ?? "").trim()])
                .filter(([_, v]) => Boolean(v)))
            : undefined;
        const meta = { ...baseMeta, accountId: normalizedAccountId };
        let reqs = await readPairingRequests(filePath);
        const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
        reqs = prunedExpired;
        const normalizedMatchingAccountId = normalizedAccountId;
        const existingIdx = reqs.findIndex((r) => {
            if (r.id !== id) {
                return false;
            }
            return requestMatchesAccountId(r, normalizedMatchingAccountId);
        });
        const existingCodes = new Set(reqs.map((req) => String(req.code ?? "")
            .trim()
            .toUpperCase()));
        if (existingIdx >= 0) {
            const existing = reqs[existingIdx];
            const existingCode = existing && typeof existing.code === "string" ? existing.code.trim() : "";
            const code = existingCode || generateUniqueCode(existingCodes);
            const next = {
                id,
                code,
                createdAt: existing?.createdAt ?? now,
                lastSeenAt: now,
                meta: meta ?? existing?.meta,
            };
            reqs[existingIdx] = next;
            const { requests: capped } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
            await writeJsonFile(filePath, {
                version: 1,
                requests: capped,
            });
            return { code, created: false };
        }
        const { requests: capped, removed: cappedRemoved } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
        reqs = capped;
        if (PAIRING_PENDING_MAX > 0 && reqs.length >= PAIRING_PENDING_MAX) {
            if (expiredRemoved || cappedRemoved) {
                await writeJsonFile(filePath, {
                    version: 1,
                    requests: reqs,
                });
            }
            return { code: "", created: false };
        }
        const code = generateUniqueCode(existingCodes);
        const next = {
            id,
            code,
            createdAt: now,
            lastSeenAt: now,
            ...(meta ? { meta } : {}),
        };
        await writeJsonFile(filePath, {
            version: 1,
            requests: [...reqs, next],
        });
        return { code, created: true };
    });
}
export async function approveChannelPairingCode(params) {
    const env = params.env ?? process.env;
    const code = params.code.trim().toUpperCase();
    if (!code) {
        return null;
    }
    const filePath = resolvePairingPath(params.channel, env);
    return await withFileLock(filePath, { version: 1, requests: [] }, async () => {
        const { requests: pruned, removed } = await readPrunedPairingRequests(filePath);
        const normalizedAccountId = normalizePairingAccountId(params.accountId);
        const idx = pruned.findIndex((r) => {
            if (String(r.code ?? "").toUpperCase() !== code) {
                return false;
            }
            return requestMatchesAccountId(r, normalizedAccountId);
        });
        if (idx < 0) {
            if (removed) {
                await writeJsonFile(filePath, {
                    version: 1,
                    requests: pruned,
                });
            }
            return null;
        }
        const entry = pruned[idx];
        if (!entry) {
            return null;
        }
        pruned.splice(idx, 1);
        await writeJsonFile(filePath, {
            version: 1,
            requests: pruned,
        });
        const entryAccountId = String(entry.meta?.accountId ?? "").trim() || undefined;
        await addChannelAllowFromStoreEntry({
            channel: params.channel,
            entry: entry.id,
            accountId: params.accountId?.trim() || entryAccountId,
            env,
        });
        return { id: entry.id, entry };
    });
}

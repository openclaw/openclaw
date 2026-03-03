import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS, DEFAULT_THREAD_BINDING_MAX_AGE_MS, RECENT_UNBOUND_WEBHOOK_ECHO_WINDOW_MS, THREAD_BINDINGS_VERSION, } from "./thread-bindings.types.js";
// Plugin hooks can load this module via Jiti while core imports it via ESM.
// Store mutable state on globalThis so both loader paths share one registry.
const THREAD_BINDINGS_STATE_KEY = "__openclawDiscordThreadBindingsState";
function createThreadBindingsGlobalState() {
    return {
        managersByAccountId: new Map(),
        bindingsByThreadId: new Map(),
        bindingsBySessionKey: new Map(),
        tokensByAccountId: new Map(),
        recentUnboundWebhookEchoesByBindingKey: new Map(),
        reusableWebhooksByAccountChannel: new Map(),
        persistByAccountId: new Map(),
        loadedBindings: false,
        lastPersistedAtMs: 0,
    };
}
function resolveThreadBindingsGlobalState() {
    const runtimeGlobal = globalThis;
    if (!runtimeGlobal[THREAD_BINDINGS_STATE_KEY]) {
        runtimeGlobal[THREAD_BINDINGS_STATE_KEY] = createThreadBindingsGlobalState();
    }
    return runtimeGlobal[THREAD_BINDINGS_STATE_KEY];
}
const THREAD_BINDINGS_STATE = resolveThreadBindingsGlobalState();
export const MANAGERS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.managersByAccountId;
export const BINDINGS_BY_THREAD_ID = THREAD_BINDINGS_STATE.bindingsByThreadId;
export const BINDINGS_BY_SESSION_KEY = THREAD_BINDINGS_STATE.bindingsBySessionKey;
export const TOKENS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.tokensByAccountId;
export const RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY = THREAD_BINDINGS_STATE.recentUnboundWebhookEchoesByBindingKey;
export const REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL = THREAD_BINDINGS_STATE.reusableWebhooksByAccountChannel;
export const PERSIST_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.persistByAccountId;
export const THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15000;
export function rememberThreadBindingToken(params) {
    const normalizedAccountId = normalizeAccountId(params.accountId);
    const token = params.token?.trim();
    if (!token) {
        return;
    }
    TOKENS_BY_ACCOUNT_ID.set(normalizedAccountId, token);
}
export function forgetThreadBindingToken(accountId) {
    TOKENS_BY_ACCOUNT_ID.delete(normalizeAccountId(accountId));
}
export function getThreadBindingToken(accountId) {
    return TOKENS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
}
export function shouldDefaultPersist() {
    return !(process.env.VITEST || process.env.NODE_ENV === "test");
}
export function resolveThreadBindingsPath() {
    return path.join(resolveStateDir(process.env), "discord", "thread-bindings.json");
}
export function normalizeTargetKind(raw, targetSessionKey) {
    if (raw === "subagent" || raw === "acp") {
        return raw;
    }
    return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}
export function normalizeThreadId(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return String(Math.floor(raw));
    }
    if (typeof raw !== "string") {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
}
export function toBindingRecordKey(params) {
    return `${normalizeAccountId(params.accountId)}:${params.threadId.trim()}`;
}
export function resolveBindingRecordKey(params) {
    const threadId = normalizeThreadId(params.threadId);
    if (!threadId) {
        return undefined;
    }
    return toBindingRecordKey({
        accountId: normalizeAccountId(params.accountId),
        threadId,
    });
}
function normalizePersistedBinding(threadIdKey, raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const value = raw;
    const threadId = normalizeThreadId(value.threadId ?? threadIdKey);
    const channelId = typeof value.channelId === "string" ? value.channelId.trim() : "";
    const targetSessionKey = typeof value.targetSessionKey === "string"
        ? value.targetSessionKey.trim()
        : typeof value.sessionKey === "string"
            ? value.sessionKey.trim()
            : "";
    if (!threadId || !channelId || !targetSessionKey) {
        return null;
    }
    const accountId = normalizeAccountId(value.accountId);
    const targetKind = normalizeTargetKind(value.targetKind, targetSessionKey);
    const agentIdRaw = typeof value.agentId === "string" ? value.agentId.trim() : "";
    const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
    const label = typeof value.label === "string" ? value.label.trim() || undefined : undefined;
    const webhookId = typeof value.webhookId === "string" ? value.webhookId.trim() || undefined : undefined;
    const webhookToken = typeof value.webhookToken === "string" ? value.webhookToken.trim() || undefined : undefined;
    const boundBy = typeof value.boundBy === "string" ? value.boundBy.trim() || "system" : "system";
    const boundAt = typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
        ? Math.floor(value.boundAt)
        : Date.now();
    const lastActivityAt = typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
        ? Math.max(0, Math.floor(value.lastActivityAt))
        : boundAt;
    const idleTimeoutMs = typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs)
        ? Math.max(0, Math.floor(value.idleTimeoutMs))
        : undefined;
    const maxAgeMs = typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs)
        ? Math.max(0, Math.floor(value.maxAgeMs))
        : undefined;
    const legacyExpiresAt = typeof value.expiresAt === "number" &&
        Number.isFinite(value.expiresAt)
        ? Math.max(0, Math.floor(value.expiresAt ?? 0))
        : undefined;
    let migratedIdleTimeoutMs = idleTimeoutMs;
    let migratedMaxAgeMs = maxAgeMs;
    if (migratedIdleTimeoutMs === undefined &&
        migratedMaxAgeMs === undefined &&
        legacyExpiresAt != null) {
        if (legacyExpiresAt <= 0) {
            migratedIdleTimeoutMs = 0;
            migratedMaxAgeMs = 0;
        }
        else {
            const baseBoundAt = boundAt > 0 ? boundAt : lastActivityAt;
            // Legacy expiresAt represented an absolute timestamp; map it to max-age and disable idle timeout.
            migratedIdleTimeoutMs = 0;
            migratedMaxAgeMs = Math.max(1, legacyExpiresAt - Math.max(0, baseBoundAt));
        }
    }
    return {
        accountId,
        channelId,
        threadId,
        targetKind,
        targetSessionKey,
        agentId,
        label,
        webhookId,
        webhookToken,
        boundBy,
        boundAt,
        lastActivityAt,
        idleTimeoutMs: migratedIdleTimeoutMs,
        maxAgeMs: migratedMaxAgeMs,
    };
}
export function normalizeThreadBindingDurationMs(raw, defaultsTo) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return defaultsTo;
    }
    const durationMs = Math.floor(raw);
    if (durationMs < 0) {
        return defaultsTo;
    }
    return durationMs;
}
export function resolveThreadBindingIdleTimeoutMs(params) {
    const explicit = params.record.idleTimeoutMs;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
        return Math.max(0, Math.floor(explicit));
    }
    return Math.max(0, Math.floor(params.defaultIdleTimeoutMs));
}
export function resolveThreadBindingMaxAgeMs(params) {
    const explicit = params.record.maxAgeMs;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
        return Math.max(0, Math.floor(explicit));
    }
    return Math.max(0, Math.floor(params.defaultMaxAgeMs));
}
export function resolveThreadBindingInactivityExpiresAt(params) {
    const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
        record: params.record,
        defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
    });
    if (idleTimeoutMs <= 0) {
        return undefined;
    }
    const lastActivityAt = Math.floor(params.record.lastActivityAt);
    if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
        return undefined;
    }
    return lastActivityAt + idleTimeoutMs;
}
export function resolveThreadBindingMaxAgeExpiresAt(params) {
    const maxAgeMs = resolveThreadBindingMaxAgeMs({
        record: params.record,
        defaultMaxAgeMs: params.defaultMaxAgeMs,
    });
    if (maxAgeMs <= 0) {
        return undefined;
    }
    const boundAt = Math.floor(params.record.boundAt);
    if (!Number.isFinite(boundAt) || boundAt <= 0) {
        return undefined;
    }
    return boundAt + maxAgeMs;
}
function linkSessionBinding(targetSessionKey, bindingKey) {
    const key = targetSessionKey.trim();
    if (!key) {
        return;
    }
    const threads = BINDINGS_BY_SESSION_KEY.get(key) ?? new Set();
    threads.add(bindingKey);
    BINDINGS_BY_SESSION_KEY.set(key, threads);
}
function unlinkSessionBinding(targetSessionKey, bindingKey) {
    const key = targetSessionKey.trim();
    if (!key) {
        return;
    }
    const threads = BINDINGS_BY_SESSION_KEY.get(key);
    if (!threads) {
        return;
    }
    threads.delete(bindingKey);
    if (threads.size === 0) {
        BINDINGS_BY_SESSION_KEY.delete(key);
    }
}
export function toReusableWebhookKey(params) {
    return `${params.accountId.trim().toLowerCase()}:${params.channelId.trim()}`;
}
export function rememberReusableWebhook(record) {
    const webhookId = record.webhookId?.trim();
    const webhookToken = record.webhookToken?.trim();
    if (!webhookId || !webhookToken) {
        return;
    }
    const key = toReusableWebhookKey({
        accountId: record.accountId,
        channelId: record.channelId,
    });
    REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.set(key, { webhookId, webhookToken });
}
export function rememberRecentUnboundWebhookEcho(record) {
    const webhookId = record.webhookId?.trim();
    if (!webhookId) {
        return;
    }
    const bindingKey = resolveBindingRecordKey({
        accountId: record.accountId,
        threadId: record.threadId,
    });
    if (!bindingKey) {
        return;
    }
    RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.set(bindingKey, {
        webhookId,
        expiresAt: Date.now() + RECENT_UNBOUND_WEBHOOK_ECHO_WINDOW_MS,
    });
}
function clearRecentUnboundWebhookEcho(bindingKeyRaw) {
    const key = bindingKeyRaw.trim();
    if (!key) {
        return;
    }
    RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.delete(key);
}
export function setBindingRecord(record) {
    const bindingKey = toBindingRecordKey({
        accountId: record.accountId,
        threadId: record.threadId,
    });
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (existing) {
        unlinkSessionBinding(existing.targetSessionKey, bindingKey);
    }
    BINDINGS_BY_THREAD_ID.set(bindingKey, record);
    linkSessionBinding(record.targetSessionKey, bindingKey);
    clearRecentUnboundWebhookEcho(bindingKey);
    rememberReusableWebhook(record);
}
export function removeBindingRecord(bindingKeyRaw) {
    const key = bindingKeyRaw.trim();
    if (!key) {
        return null;
    }
    const existing = BINDINGS_BY_THREAD_ID.get(key);
    if (!existing) {
        return null;
    }
    BINDINGS_BY_THREAD_ID.delete(key);
    unlinkSessionBinding(existing.targetSessionKey, key);
    return existing;
}
export function isRecentlyUnboundThreadWebhookMessage(params) {
    const webhookId = params.webhookId?.trim() || "";
    if (!webhookId) {
        return false;
    }
    const bindingKey = resolveBindingRecordKey({
        accountId: params.accountId,
        threadId: params.threadId,
    });
    if (!bindingKey) {
        return false;
    }
    const suppressed = RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.get(bindingKey);
    if (!suppressed) {
        return false;
    }
    if (suppressed.expiresAt <= Date.now()) {
        RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.delete(bindingKey);
        return false;
    }
    return suppressed.webhookId === webhookId;
}
function shouldPersistAnyBindingState() {
    for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
        if (value) {
            return true;
        }
    }
    return false;
}
export function shouldPersistBindingMutations() {
    if (shouldPersistAnyBindingState()) {
        return true;
    }
    return fs.existsSync(resolveThreadBindingsPath());
}
export function saveBindingsToDisk(params = {}) {
    if (!params.force && !shouldPersistAnyBindingState()) {
        return;
    }
    const minIntervalMs = typeof params.minIntervalMs === "number" && Number.isFinite(params.minIntervalMs)
        ? Math.max(0, Math.floor(params.minIntervalMs))
        : 0;
    const now = Date.now();
    if (!params.force &&
        minIntervalMs > 0 &&
        THREAD_BINDINGS_STATE.lastPersistedAtMs > 0 &&
        now - THREAD_BINDINGS_STATE.lastPersistedAtMs < minIntervalMs) {
        return;
    }
    const bindings = {};
    for (const [bindingKey, record] of BINDINGS_BY_THREAD_ID.entries()) {
        bindings[bindingKey] = { ...record };
    }
    const payload = {
        version: THREAD_BINDINGS_VERSION,
        bindings,
    };
    saveJsonFile(resolveThreadBindingsPath(), payload);
    THREAD_BINDINGS_STATE.lastPersistedAtMs = now;
}
export function ensureBindingsLoaded() {
    if (THREAD_BINDINGS_STATE.loadedBindings) {
        return;
    }
    THREAD_BINDINGS_STATE.loadedBindings = true;
    BINDINGS_BY_THREAD_ID.clear();
    BINDINGS_BY_SESSION_KEY.clear();
    REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.clear();
    const raw = loadJsonFile(resolveThreadBindingsPath());
    if (!raw || typeof raw !== "object") {
        return;
    }
    const payload = raw;
    if (payload.version !== 1 || !payload.bindings || typeof payload.bindings !== "object") {
        return;
    }
    for (const [threadId, entry] of Object.entries(payload.bindings)) {
        const normalized = normalizePersistedBinding(threadId, entry);
        if (!normalized) {
            continue;
        }
        setBindingRecord(normalized);
    }
}
export function resolveBindingIdsForSession(params) {
    const key = params.targetSessionKey.trim();
    if (!key) {
        return [];
    }
    const ids = BINDINGS_BY_SESSION_KEY.get(key);
    if (!ids) {
        return [];
    }
    const out = [];
    for (const bindingKey of ids.values()) {
        const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!record) {
            continue;
        }
        if (params.accountId && record.accountId !== params.accountId) {
            continue;
        }
        if (params.targetKind && record.targetKind !== params.targetKind) {
            continue;
        }
        out.push(bindingKey);
    }
    return out;
}
export function resolveDefaultThreadBindingDurations() {
    return {
        defaultIdleTimeoutMs: DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
        defaultMaxAgeMs: DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    };
}
export function resetThreadBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
        manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_THREAD_ID.clear();
    BINDINGS_BY_SESSION_KEY.clear();
    RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.clear();
    REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.clear();
    TOKENS_BY_ACCOUNT_ID.clear();
    PERSIST_BY_ACCOUNT_ID.clear();
    THREAD_BINDINGS_STATE.loadedBindings = false;
    THREAD_BINDINGS_STATE.lastPersistedAtMs = 0;
}

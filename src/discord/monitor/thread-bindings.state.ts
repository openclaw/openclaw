import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  DEFAULT_THREAD_BINDING_TTL_MS,
  RECENT_UNBOUND_WEBHOOK_ECHO_TTL_MS,
  THREAD_BINDINGS_VERSION,
  type PersistedThreadBindingRecord,
  type PersistedThreadBindingsPayload,
  type ThreadBindingManager,
  type ThreadBindingRecord,
  type ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

type ThreadBindingsGlobalState = {
  managersByAccountId: Map<string, ThreadBindingManager>;
  bindingsByThreadId: Map<string, ThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  tokensByAccountId: Map<string, string>;
  recentUnboundWebhookEchoesByBindingKey: Map<string, { webhookId: string; expiresAt: number }>;
  reusableWebhooksByAccountChannel: Map<string, { webhookId: string; webhookToken: string }>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
};

// Plugin hooks can load this module via Jiti while core imports it via ESM.
// Store mutable state on globalThis so both loader paths share one registry.
const THREAD_BINDINGS_STATE_KEY = "__openclawDiscordThreadBindingsState";

function createThreadBindingsGlobalState(): ThreadBindingsGlobalState {
  return {
    managersByAccountId: new Map<string, ThreadBindingManager>(),
    bindingsByThreadId: new Map<string, ThreadBindingRecord>(),
    bindingsBySessionKey: new Map<string, Set<string>>(),
    tokensByAccountId: new Map<string, string>(),
    recentUnboundWebhookEchoesByBindingKey: new Map<
      string,
      { webhookId: string; expiresAt: number }
    >(),
    reusableWebhooksByAccountChannel: new Map<
      string,
      { webhookId: string; webhookToken: string }
    >(),
    persistByAccountId: new Map<string, boolean>(),
    loadedBindings: false,
  };
}

function resolveThreadBindingsGlobalState(): ThreadBindingsGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [THREAD_BINDINGS_STATE_KEY]?: ThreadBindingsGlobalState;
  };
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
export const RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY =
  THREAD_BINDINGS_STATE.recentUnboundWebhookEchoesByBindingKey;
export const REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL =
  THREAD_BINDINGS_STATE.reusableWebhooksByAccountChannel;
export const PERSIST_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.persistByAccountId;

export function rememberThreadBindingToken(params: { accountId?: string; token?: string }) {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const token = params.token?.trim();
  if (!token) {
    return;
  }
  TOKENS_BY_ACCOUNT_ID.set(normalizedAccountId, token);
}

export function forgetThreadBindingToken(accountId?: string) {
  TOKENS_BY_ACCOUNT_ID.delete(normalizeAccountId(accountId));
}

export function getThreadBindingToken(accountId?: string): string | undefined {
  return TOKENS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
}

export function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

export function resolveThreadBindingsPath(): string {
  return path.join(resolveStateDir(process.env), "discord", "thread-bindings.json");
}

export function normalizeTargetKind(
  raw: unknown,
  targetSessionKey: string,
): ThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") {
    return raw;
  }
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

export function normalizeThreadId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(Math.floor(raw));
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function toBindingRecordKey(params: { accountId: string; threadId: string }): string {
  return `${normalizeAccountId(params.accountId)}:${params.threadId.trim()}`;
}

export function resolveBindingRecordKey(params: {
  accountId?: string;
  threadId: string;
}): string | undefined {
  const threadId = normalizeThreadId(params.threadId);
  if (!threadId) {
    return undefined;
  }
  return toBindingRecordKey({
    accountId: normalizeAccountId(params.accountId),
    threadId,
  });
}

function normalizePersistedBinding(threadIdKey: string, raw: unknown): ThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<PersistedThreadBindingRecord>;
  const threadId = normalizeThreadId(value.threadId ?? threadIdKey);
  const channelId = typeof value.channelId === "string" ? value.channelId.trim() : "";
  const targetSessionKey =
    typeof value.targetSessionKey === "string"
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
  const webhookId =
    typeof value.webhookId === "string" ? value.webhookId.trim() || undefined : undefined;
  const webhookToken =
    typeof value.webhookToken === "string" ? value.webhookToken.trim() || undefined : undefined;
  const boundBy = typeof value.boundBy === "string" ? value.boundBy.trim() || "system" : "system";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.floor(value.boundAt)
      : Date.now();
  const expiresAt =
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? Math.max(0, Math.floor(value.expiresAt))
      : undefined;
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
    expiresAt,
  };
}

export function normalizeThreadBindingTtlMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_THREAD_BINDING_TTL_MS;
  }
  const ttlMs = Math.floor(raw);
  if (ttlMs < 0) {
    return DEFAULT_THREAD_BINDING_TTL_MS;
  }
  return ttlMs;
}

export function resolveThreadBindingExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "expiresAt">;
  sessionTtlMs: number;
}): number | undefined {
  if (typeof params.record.expiresAt === "number" && Number.isFinite(params.record.expiresAt)) {
    const explicitExpiresAt = Math.floor(params.record.expiresAt);
    if (explicitExpiresAt <= 0) {
      // 0 is an explicit per-binding TTL disable sentinel.
      return undefined;
    }
    return explicitExpiresAt;
  }
  if (params.sessionTtlMs <= 0) {
    return undefined;
  }
  const boundAt = Math.floor(params.record.boundAt);
  if (!Number.isFinite(boundAt) || boundAt <= 0) {
    return undefined;
  }
  return boundAt + params.sessionTtlMs;
}

function linkSessionBinding(targetSessionKey: string, bindingKey: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key) ?? new Set<string>();
  threads.add(bindingKey);
  BINDINGS_BY_SESSION_KEY.set(key, threads);
}

function unlinkSessionBinding(targetSessionKey: string, bindingKey: string) {
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

export function toReusableWebhookKey(params: { accountId: string; channelId: string }): string {
  return `${params.accountId.trim().toLowerCase()}:${params.channelId.trim()}`;
}

export function rememberReusableWebhook(record: ThreadBindingRecord) {
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

export function rememberRecentUnboundWebhookEcho(record: ThreadBindingRecord) {
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
    expiresAt: Date.now() + RECENT_UNBOUND_WEBHOOK_ECHO_TTL_MS,
  });
}

function clearRecentUnboundWebhookEcho(bindingKeyRaw: string) {
  const key = bindingKeyRaw.trim();
  if (!key) {
    return;
  }
  RECENT_UNBOUND_WEBHOOK_ECHOES_BY_BINDING_KEY.delete(key);
}

export function setBindingRecord(record: ThreadBindingRecord) {
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

export function removeBindingRecord(bindingKeyRaw: string): ThreadBindingRecord | null {
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

export function isRecentlyUnboundThreadWebhookMessage(params: {
  accountId?: string;
  threadId: string;
  webhookId?: string | null;
}): boolean {
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

function shouldPersistAnyBindingState(): boolean {
  for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

export function shouldPersistBindingMutations(): boolean {
  if (shouldPersistAnyBindingState()) {
    return true;
  }
  return fs.existsSync(resolveThreadBindingsPath());
}

export function saveBindingsToDisk(params: { force?: boolean } = {}) {
  if (!params.force && !shouldPersistAnyBindingState()) {
    return;
  }
  const bindings: Record<string, PersistedThreadBindingRecord> = {};
  for (const [bindingKey, record] of BINDINGS_BY_THREAD_ID.entries()) {
    bindings[bindingKey] = { ...record };
  }
  const payload: PersistedThreadBindingsPayload = {
    version: THREAD_BINDINGS_VERSION,
    bindings,
  };
  saveJsonFile(resolveThreadBindingsPath(), payload);
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
  const payload = raw as Partial<PersistedThreadBindingsPayload>;
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

export function resolveBindingIdsForSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): string[] {
  const key = params.targetSessionKey.trim();
  if (!key) {
    return [];
  }
  const ids = BINDINGS_BY_SESSION_KEY.get(key);
  if (!ids) {
    return [];
  }
  const out: string[] = [];
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
}

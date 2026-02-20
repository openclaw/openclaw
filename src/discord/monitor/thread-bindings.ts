import path from "node:path";
import { ChannelType, Routes } from "discord-api-types/v10";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createDiscordRestClient } from "../client.js";
import { sendMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { createThreadDiscord } from "../send.messages.js";
import { parseDiscordTarget } from "../targets.js";

export type ThreadBindingTargetKind = "subagent" | "acp";

export type ThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: ThreadBindingTargetKind;
  targetSessionKey: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
  boundBy: string;
  boundAt: number;
  expiresAt?: number;
};

type PersistedThreadBindingRecord = ThreadBindingRecord & {
  sessionKey?: string;
};

type PersistedThreadBindingsPayload = {
  version: 1;
  bindings: Record<string, PersistedThreadBindingRecord>;
};

export type ThreadBindingManager = {
  accountId: string;
  getSessionTtlMs: () => number;
  getByThreadId: (threadId: string) => ThreadBindingRecord | undefined;
  getBySessionKey: (targetSessionKey: string) => ThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => ThreadBindingRecord[];
  listBindings: () => ThreadBindingRecord[];
  bindTarget: (params: {
    threadId?: string | number;
    channelId?: string;
    createThread?: boolean;
    threadName?: string;
    targetKind: ThreadBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    introText?: string;
    webhookId?: string;
    webhookToken?: string;
  }) => Promise<ThreadBindingRecord | null>;
  unbindThread: (params: {
    threadId: string;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord[];
  stop: () => void;
};

const THREAD_BINDINGS_VERSION = 1 as const;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000;
const DEFAULT_THREAD_BINDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_FAREWELL_TEXT = "Session ended. Messages here will no longer be routed.";

type ThreadBindingsGlobalState = {
  managersByAccountId: Map<string, ThreadBindingManager>;
  bindingsByThreadId: Map<string, ThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
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
const MANAGERS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.managersByAccountId;
const BINDINGS_BY_THREAD_ID = THREAD_BINDINGS_STATE.bindingsByThreadId;
const BINDINGS_BY_SESSION_KEY = THREAD_BINDINGS_STATE.bindingsBySessionKey;
const PERSIST_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.persistByAccountId;

function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

function resolveThreadBindingsPath(): string {
  return path.join(resolveStateDir(process.env), "discord", "thread-bindings.json");
}

function normalizeTargetKind(raw: unknown, targetSessionKey: string): ThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") {
    return raw;
  }
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

function normalizeThreadId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(Math.floor(raw));
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
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
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && value.expiresAt > 0
      ? Math.floor(value.expiresAt)
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

function normalizeThreadBindingTtlMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_THREAD_BINDING_TTL_MS;
  }
  const ttlMs = Math.floor(raw);
  if (ttlMs < 0) {
    return DEFAULT_THREAD_BINDING_TTL_MS;
  }
  return ttlMs;
}

function formatThreadBindingTtlLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return "disabled";
  }
  if (ttlMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(ttlMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

function resolveThreadBindingExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "expiresAt">;
  sessionTtlMs: number;
}): number | undefined {
  if (
    typeof params.record.expiresAt === "number" &&
    Number.isFinite(params.record.expiresAt) &&
    params.record.expiresAt > 0
  ) {
    return Math.floor(params.record.expiresAt);
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

function linkSessionBinding(targetSessionKey: string, threadId: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key) ?? new Set<string>();
  threads.add(threadId);
  BINDINGS_BY_SESSION_KEY.set(key, threads);
}

function unlinkSessionBinding(targetSessionKey: string, threadId: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key);
  if (!threads) {
    return;
  }
  threads.delete(threadId);
  if (threads.size === 0) {
    BINDINGS_BY_SESSION_KEY.delete(key);
  }
}

function setBindingRecord(record: ThreadBindingRecord) {
  const existing = BINDINGS_BY_THREAD_ID.get(record.threadId);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, existing.threadId);
  }
  BINDINGS_BY_THREAD_ID.set(record.threadId, record);
  linkSessionBinding(record.targetSessionKey, record.threadId);
}

function removeBindingRecord(threadId: string): ThreadBindingRecord | null {
  const key = threadId.trim();
  if (!key) {
    return null;
  }
  const existing = BINDINGS_BY_THREAD_ID.get(key);
  if (!existing) {
    return null;
  }
  BINDINGS_BY_THREAD_ID.delete(key);
  unlinkSessionBinding(existing.targetSessionKey, existing.threadId);
  return existing;
}

function shouldPersistAnyBindingState(): boolean {
  for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

function saveBindingsToDisk() {
  if (!shouldPersistAnyBindingState()) {
    return;
  }
  const bindings: Record<string, PersistedThreadBindingRecord> = {};
  for (const [threadId, record] of BINDINGS_BY_THREAD_ID.entries()) {
    bindings[threadId] = { ...record };
  }
  const payload: PersistedThreadBindingsPayload = {
    version: THREAD_BINDINGS_VERSION,
    bindings,
  };
  saveJsonFile(resolveThreadBindingsPath(), payload);
}

function ensureBindingsLoaded() {
  if (THREAD_BINDINGS_STATE.loadedBindings) {
    return;
  }
  THREAD_BINDINGS_STATE.loadedBindings = true;
  BINDINGS_BY_THREAD_ID.clear();
  BINDINGS_BY_SESSION_KEY.clear();

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

export function resolveThreadBindingThreadName(params: {
  agentId?: string;
  label?: string;
}): string {
  const label = params.label?.trim();
  const base = label || params.agentId?.trim() || "agent";
  const raw = `🤖 ${base}`.replace(/\s+/g, " ").trim();
  return raw.slice(0, 100);
}

export function resolveThreadBindingIntroText(params: {
  agentId?: string;
  label?: string;
  sessionTtlMs?: number;
}): string {
  const label = params.label?.trim();
  const base = label || params.agentId?.trim() || "agent";
  const normalized = base.replace(/\s+/g, " ").trim().slice(0, 100) || "agent";
  const ttlMs = normalizeThreadBindingTtlMs(params.sessionTtlMs);
  if (ttlMs > 0) {
    return `🤖 ${normalized} session active (auto-unfocus in ${formatThreadBindingTtlLabel(ttlMs)}). Messages here go directly to this session.`;
  }
  return `🤖 ${normalized} session active. Messages here go directly to this session.`;
}

function resolveThreadBindingFarewellText(params: {
  reason?: string;
  farewellText?: string;
  sessionTtlMs: number;
}): string {
  const custom = params.farewellText?.trim();
  if (custom) {
    return custom;
  }
  if (params.reason === "ttl-expired") {
    return `Session ended automatically after ${formatThreadBindingTtlLabel(params.sessionTtlMs)}. Messages here will no longer be routed.`;
  }
  return DEFAULT_FAREWELL_TEXT;
}

function summarizeBindingPersona(record: ThreadBindingRecord): string {
  const label = record.label?.trim();
  const base = label || record.agentId;
  return (`🤖 ${base}`.trim() || "🤖 agent").slice(0, 80);
}

function resolveBindingIdsForSession(params: {
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
  for (const threadId of ids.values()) {
    const record = BINDINGS_BY_THREAD_ID.get(threadId);
    if (!record) {
      continue;
    }
    if (params.accountId && record.accountId !== params.accountId) {
      continue;
    }
    if (params.targetKind && record.targetKind !== params.targetKind) {
      continue;
    }
    out.push(threadId);
  }
  return out;
}

function buildThreadTarget(threadId: string): string {
  return `channel:${threadId}`;
}

function isThreadArchived(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const asRecord = raw as {
    archived?: unknown;
    thread_metadata?: { archived?: unknown };
    threadMetadata?: { archived?: unknown };
  };
  if (asRecord.archived === true) {
    return true;
  }
  if (asRecord.thread_metadata?.archived === true) {
    return true;
  }
  if (asRecord.threadMetadata?.archived === true) {
    return true;
  }
  return false;
}

function isThreadChannelType(type: unknown): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function summarizeDiscordError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint" ||
    typeof err === "symbol"
  ) {
    return String(err);
  }
  return "error";
}

async function maybeSendBindingMessage(params: { record: ThreadBindingRecord; text: string }) {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const record = params.record;
  if (record.webhookId && record.webhookToken) {
    try {
      await sendWebhookMessageDiscord(text, {
        webhookId: record.webhookId,
        webhookToken: record.webhookToken,
        threadId: record.threadId,
        username: summarizeBindingPersona(record),
      });
      return;
    } catch (err) {
      logVerbose(`discord thread binding webhook send failed: ${summarizeDiscordError(err)}`);
    }
  }
  try {
    await sendMessageDiscord(buildThreadTarget(record.threadId), text, {
      accountId: record.accountId,
    });
  } catch (err) {
    logVerbose(`discord thread binding fallback send failed: ${summarizeDiscordError(err)}`);
  }
}

async function createWebhookForChannel(params: {
  accountId: string;
  token?: string;
  channelId: string;
}): Promise<{ webhookId?: string; webhookToken?: string }> {
  try {
    const rest = createDiscordRestClient({
      accountId: params.accountId,
      token: params.token,
    }).rest;
    const created = (await rest.post(Routes.channelWebhooks(params.channelId), {
      body: {
        name: "OpenClaw Agents",
      },
    })) as { id?: string; token?: string };
    const webhookId = typeof created?.id === "string" ? created.id.trim() : "";
    const webhookToken = typeof created?.token === "string" ? created.token.trim() : "";
    if (!webhookId || !webhookToken) {
      return {};
    }
    return { webhookId, webhookToken };
  } catch (err) {
    logVerbose(
      `discord thread binding webhook create failed for ${params.channelId}: ${summarizeDiscordError(err)}`,
    );
    return {};
  }
}

function findReusableWebhook(params: { accountId: string; channelId: string }): {
  webhookId?: string;
  webhookToken?: string;
} {
  for (const record of BINDINGS_BY_THREAD_ID.values()) {
    if (record.accountId !== params.accountId) {
      continue;
    }
    if (record.channelId !== params.channelId) {
      continue;
    }
    if (!record.webhookId || !record.webhookToken) {
      continue;
    }
    return {
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
    };
  }
  return {};
}

async function resolveChannelIdForBinding(params: {
  accountId: string;
  token?: string;
  threadId: string;
  channelId?: string;
}): Promise<string | null> {
  const explicit = params.channelId?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const rest = createDiscordRestClient({
      accountId: params.accountId,
      token: params.token,
    }).rest;
    const channel = (await rest.get(Routes.channel(params.threadId))) as {
      id?: string;
      type?: number;
      parent_id?: string;
      parentId?: string;
    };
    const parentId =
      typeof channel?.parent_id === "string"
        ? channel.parent_id.trim()
        : typeof channel?.parentId === "string"
          ? channel.parentId.trim()
          : "";
    if (parentId) {
      return parentId;
    }
    const channelId = typeof channel?.id === "string" ? channel.id.trim() : "";
    const type = channel?.type;
    if (channelId && !isThreadChannelType(type)) {
      return channelId;
    }
    return channelId || null;
  } catch (err) {
    logVerbose(
      `discord thread binding channel resolve failed for ${params.threadId}: ${summarizeDiscordError(err)}`,
    );
    return null;
  }
}

async function createThreadForBinding(params: {
  accountId: string;
  token?: string;
  channelId: string;
  threadName: string;
}): Promise<string | null> {
  try {
    const created = await createThreadDiscord(
      params.channelId,
      {
        name: params.threadName,
        autoArchiveMinutes: 60,
      },
      {
        accountId: params.accountId,
        token: params.token,
      },
    );
    const createdId = typeof created?.id === "string" ? created.id.trim() : "";
    return createdId || null;
  } catch (err) {
    logVerbose(
      `discord thread binding auto-thread create failed for ${params.channelId}: ${summarizeDiscordError(err)}`,
    );
    return null;
  }
}

function registerManager(manager: ThreadBindingManager) {
  MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}

function unregisterManager(accountId: string, manager: ThreadBindingManager) {
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing === manager) {
    MANAGERS_BY_ACCOUNT_ID.delete(accountId);
  }
}

function createNoopManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  return {
    accountId,
    getSessionTtlMs: () => DEFAULT_THREAD_BINDING_TTL_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

export function createThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    persist?: boolean;
    enableSweeper?: boolean;
    sessionTtlMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const sessionTtlMs = normalizeThreadBindingTtlMs(params.sessionTtlMs);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: ThreadBindingManager = {
    accountId,
    getSessionTtlMs: () => sessionTtlMs,
    getByThreadId: (threadId) => {
      const key = threadId.trim();
      if (!key) {
        return undefined;
      }
      const entry = BINDINGS_BY_THREAD_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((threadId) => BINDINGS_BY_THREAD_ID.get(threadId))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
    bindTarget: async (bindParams) => {
      let threadId = normalizeThreadId(bindParams.threadId);
      let channelId = bindParams.channelId?.trim() || "";

      if (!threadId && bindParams.createThread) {
        if (!channelId) {
          return null;
        }
        const threadName = resolveThreadBindingThreadName({
          agentId: bindParams.agentId,
          label: bindParams.label,
        });
        threadId =
          (await createThreadForBinding({
            accountId,
            token: params.token,
            channelId,
            threadName: bindParams.threadName?.trim() || threadName,
          })) ?? undefined;
      }

      if (!threadId) {
        return null;
      }

      if (!channelId) {
        channelId =
          (await resolveChannelIdForBinding({
            accountId,
            token: params.token,
            threadId,
            channelId: bindParams.channelId,
          })) ?? "";
      }
      if (!channelId) {
        return null;
      }

      const targetSessionKey = bindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }

      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      let webhookId = bindParams.webhookId?.trim() || "";
      let webhookToken = bindParams.webhookToken?.trim() || "";
      if (!webhookId || !webhookToken) {
        const cachedWebhook = findReusableWebhook({ accountId, channelId });
        webhookId = cachedWebhook.webhookId ?? "";
        webhookToken = cachedWebhook.webhookToken ?? "";
      }
      if (!webhookId || !webhookToken) {
        const createdWebhook = await createWebhookForChannel({
          accountId,
          token: params.token,
          channelId,
        });
        webhookId = createdWebhook.webhookId ?? "";
        webhookToken = createdWebhook.webhookToken ?? "";
      }

      const boundAt = Date.now();
      const record: ThreadBindingRecord = {
        accountId,
        channelId,
        threadId,
        targetKind,
        targetSessionKey,
        agentId: bindParams.agentId?.trim() || resolveAgentIdFromSessionKey(targetSessionKey),
        label: bindParams.label?.trim() || undefined,
        webhookId: webhookId || undefined,
        webhookToken: webhookToken || undefined,
        boundBy: bindParams.boundBy?.trim() || "system",
        boundAt,
        expiresAt: sessionTtlMs > 0 ? boundAt + sessionTtlMs : undefined,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }

      const introText = bindParams.introText?.trim();
      if (introText) {
        void maybeSendBindingMessage({ record, text: introText });
      }
      return record;
    },
    unbindThread: (unbindParams) => {
      const threadId = unbindParams.threadId.trim();
      if (!threadId) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(threadId);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const removed = removeBindingRecord(threadId);
      if (!removed) {
        return null;
      }
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false) {
        const farewell = resolveThreadBindingFarewellText({
          reason: unbindParams.reason,
          farewellText: unbindParams.farewellText,
          sessionTtlMs,
        });
        void maybeSendBindingMessage({ record: removed, text: farewell });
      }
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey: unbindParams.targetSessionKey,
        accountId,
        targetKind: unbindParams.targetKind,
      });
      if (ids.length === 0) {
        return [];
      }
      const removed: ThreadBindingRecord[] = [];
      for (const threadId of ids) {
        const entry = manager.unbindThread({
          threadId,
          reason: unbindParams.reason,
          sendFarewell: unbindParams.sendFarewell,
          farewellText: unbindParams.farewellText,
        });
        if (entry) {
          removed.push(entry);
        }
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterManager(accountId, manager);
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      void (async () => {
        const bindings = manager.listBindings();
        if (bindings.length === 0) {
          return;
        }
        let rest;
        try {
          rest = createDiscordRestClient({ accountId, token: params.token }).rest;
        } catch {
          return;
        }
        for (const binding of bindings) {
          const expiresAt = resolveThreadBindingExpiresAt({
            record: binding,
            sessionTtlMs,
          });
          if (expiresAt != null && Date.now() >= expiresAt) {
            manager.unbindThread({
              threadId: binding.threadId,
              reason: "ttl-expired",
              sendFarewell: true,
            });
            continue;
          }
          try {
            const channel = await rest.get(Routes.channel(binding.threadId));
            if (!channel || typeof channel !== "object") {
              manager.unbindThread({
                threadId: binding.threadId,
                reason: "thread-delete",
                sendFarewell: false,
              });
              continue;
            }
            if (isThreadArchived(channel)) {
              manager.unbindThread({
                threadId: binding.threadId,
                reason: "thread-archived",
                sendFarewell: true,
              });
            }
          } catch {
            manager.unbindThread({
              threadId: binding.threadId,
              reason: "thread-delete",
              sendFarewell: false,
            });
          }
        }
      })();
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  registerManager(manager);
  return manager;
}

export function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager {
  return createNoopManager(accountId);
}

export function getThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[] {
  const manager = getThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.listBindings();
}

export async function autoBindSpawnedDiscordSubagent(params: {
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null> {
  const channel = params.channel?.trim().toLowerCase();
  if (channel !== "discord") {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }

  const existingThreadId = normalizeThreadId(params.threadId);
  let channelId: string | undefined;
  if (!existingThreadId) {
    const to = params.to?.trim() || "";
    if (!to) {
      return null;
    }
    try {
      const target = parseDiscordTarget(to, { defaultKind: "channel" });
      if (!target || target.kind !== "channel") {
        return null;
      }
      channelId = target.id;
    } catch {
      return null;
    }
  }

  return await manager.bindTarget({
    threadId: existingThreadId,
    channelId,
    createThread: !existingThreadId,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy ?? "system",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      label: params.label,
      sessionTtlMs: manager.getSessionTtlMs(),
    }),
  });
}

export function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[] {
  ensureBindingsLoaded();
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  const ids = resolveBindingIdsForSession({
    targetSessionKey,
    accountId,
    targetKind: params.targetKind,
  });
  if (ids.length === 0) {
    return [];
  }

  const removed: ThreadBindingRecord[] = [];
  for (const threadId of ids) {
    const record = BINDINGS_BY_THREAD_ID.get(threadId);
    if (!record) {
      continue;
    }
    const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
    if (manager) {
      const unbound = manager.unbindThread({
        threadId,
        reason: params.reason,
        sendFarewell: params.sendFarewell,
        farewellText: params.farewellText,
      });
      if (unbound) {
        removed.push(unbound);
      }
      continue;
    }
    const unbound = removeBindingRecord(threadId);
    if (unbound) {
      removed.push(unbound);
    }
  }

  if (removed.length > 0 && shouldPersistAnyBindingState()) {
    saveBindingsToDisk();
  }
  return removed;
}

export const __testing = {
  resolveThreadBindingsPath,
  resolveThreadBindingThreadName,
  resetThreadBindingsForTests: () => {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_THREAD_ID.clear();
    BINDINGS_BY_SESSION_KEY.clear();
    PERSIST_BY_ACCOUNT_ID.clear();
    THREAD_BINDINGS_STATE.loadedBindings = false;
  },
};

import { resolveThreadBindingConversationIdFromBindingId } from "../channels/thread-binding-id.js";
import { formatThreadBindingDurationLabel } from "../channels/thread-bindings-messages.js";
import {
  loadThreadBindingsFromDb,
  saveAllThreadBindingsToDb,
  type ThreadBindingRow,
} from "../channels/thread-bindings-sqlite.js";
import { logVerbose } from "../globals.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
type TelegramBindingTargetKind = "subagent" | "acp";

export type TelegramThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: TelegramBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export type TelegramThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => TelegramThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => TelegramThreadBindingRecord[];
  listBindings: () => TelegramThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => TelegramThreadBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => TelegramThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => TelegramThreadBindingRecord[];
  stop: () => void;
};

type TelegramThreadBindingsState = {
  managersByAccountId: Map<string, TelegramThreadBindingManager>;
  bindingsByAccountConversation: Map<string, TelegramThreadBindingRecord>;
};

/**
 * Keep Telegram thread binding state shared across bundled chunks so routing,
 * binding lookups, and binding mutations all observe the same live registry.
 */
const TELEGRAM_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.telegramThreadBindingsState");

const threadBindingsState = resolveGlobalSingleton<TelegramThreadBindingsState>(
  TELEGRAM_THREAD_BINDINGS_STATE_KEY,
  () => ({
    managersByAccountId: new Map<string, TelegramThreadBindingManager>(),
    bindingsByAccountConversation: new Map<string, TelegramThreadBindingRecord>(),
  }),
);
const MANAGERS_BY_ACCOUNT_ID = threadBindingsState.managersByAccountId;
const BINDINGS_BY_ACCOUNT_CONVERSATION = threadBindingsState.bindingsByAccountConversation;

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeConversationId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: TelegramBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toTelegramTargetKind(raw: BindingTargetKind): TelegramBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function resolveEffectiveBindingExpiresAt(params: {
  record: TelegramThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;

  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function toSessionBindingRecord(
  record: TelegramThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "telegram",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
    },
  };
}

function fromSessionBindingInput(params: {
  accountId: string;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): TelegramThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(
    resolveBindingKey({
      accountId: params.accountId,
      conversationId: params.input.conversationId,
    }),
  );

  const record: TelegramThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind: toTelegramTargetKind(params.input.targetKind),
    targetSessionKey: params.input.targetSessionKey,
    agentId:
      typeof metadata.agentId === "string" && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : existing?.agentId,
    label:
      typeof metadata.label === "string" && metadata.label.trim()
        ? metadata.label.trim()
        : existing?.label,
    boundBy:
      typeof metadata.boundBy === "string" && metadata.boundBy.trim()
        ? metadata.boundBy.trim()
        : existing?.boundBy,
    boundAt: now,
    lastActivityAt: now,
  };

  if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
  } else if (typeof existing?.idleTimeoutMs === "number") {
    record.idleTimeoutMs = existing.idleTimeoutMs;
  }

  if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
  } else if (typeof existing?.maxAgeMs === "number") {
    record.maxAgeMs = existing.maxAgeMs;
  }

  return record;
}

function recordToRow(accountId: string, record: TelegramThreadBindingRecord): ThreadBindingRow {
  const bindingKey = resolveBindingKey({ accountId, conversationId: record.conversationId });
  return {
    binding_key: bindingKey,
    channel_type: "telegram",
    account_id: accountId,
    thread_id: record.conversationId,
    channel_id: null,
    target_kind: record.targetKind,
    target_session_key: record.targetSessionKey,
    agent_id: record.agentId || null,
    label: record.label || null,
    bound_by: record.boundBy || null,
    bound_at: record.boundAt,
    last_activity_at: record.lastActivityAt,
    idle_timeout_ms: record.idleTimeoutMs ?? null,
    max_age_ms: record.maxAgeMs ?? null,
    webhook_id: null,
    webhook_token: null,
    extra_json: null,
  };
}

function summarizeLifecycleForLog(
  record: TelegramThreadBindingRecord,
  defaults: {
    idleTimeoutMs: number;
    maxAgeMs: number;
  },
) {
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  const idleLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)));
  const maxAgeLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)));
  return `idle=${idleLabel} maxAge=${maxAgeLabel}`;
}

function loadBindingsFromDb(accountId: string): TelegramThreadBindingRecord[] {
  const rows = loadThreadBindingsFromDb("telegram", accountId);
  const bindings: TelegramThreadBindingRecord[] = [];
  for (const row of rows) {
    const conversationId = normalizeConversationId(row.thread_id);
    const targetSessionKey = row.target_session_key?.trim() ?? "";
    const targetKind = row.target_kind === "subagent" ? "subagent" : "acp";
    if (!conversationId || !targetSessionKey) {
      continue;
    }
    const boundAt =
      typeof row.bound_at === "number" && Number.isFinite(row.bound_at)
        ? Math.floor(row.bound_at)
        : Date.now();
    const lastActivityAt =
      typeof row.last_activity_at === "number" && Number.isFinite(row.last_activity_at)
        ? Math.floor(row.last_activity_at)
        : boundAt;
    const record: TelegramThreadBindingRecord = {
      accountId,
      conversationId,
      targetSessionKey,
      targetKind,
      boundAt,
      lastActivityAt,
    };
    if (typeof row.idle_timeout_ms === "number" && Number.isFinite(row.idle_timeout_ms)) {
      record.idleTimeoutMs = Math.max(0, Math.floor(row.idle_timeout_ms));
    }
    if (typeof row.max_age_ms === "number" && Number.isFinite(row.max_age_ms)) {
      record.maxAgeMs = Math.max(0, Math.floor(row.max_age_ms));
    }
    if (row.agent_id?.trim()) {
      record.agentId = row.agent_id.trim();
    }
    if (row.label?.trim()) {
      record.label = row.label.trim();
    }
    if (row.bound_by?.trim()) {
      record.boundBy = row.bound_by.trim();
    }
    bindings.push(record);
  }
  return bindings;
}

function persistBindingsToDb(params: { accountId: string; persist: boolean }): void {
  if (!params.persist) {
    return;
  }
  const bindings = [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === params.accountId,
  );
  saveAllThreadBindingsToDb(
    "telegram",
    params.accountId,
    bindings.map((record) => recordToRow(params.accountId, record)),
  );
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function shouldExpireByIdle(params: {
  now: number;
  record: TelegramThreadBindingRecord;
  defaultIdleTimeoutMs: number;
}): boolean {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  if (idleTimeoutMs <= 0) {
    return false;
  }
  return (
    params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
  );
}

function shouldExpireByMaxAge(params: {
  now: number;
  record: TelegramThreadBindingRecord;
  defaultMaxAgeMs: number;
}): boolean {
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;
  if (maxAgeMs <= 0) {
    return false;
  }
  return params.now >= params.record.boundAt + maxAgeMs;
}

export function createTelegramThreadBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
  } = {},
): TelegramThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  const loaded = loadBindingsFromDb(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      conversationId: entry.conversationId,
    });
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, {
      ...entry,
      accountId,
    });
  }

  const listBindingsForAccount = () =>
    [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: TelegramThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return BINDINGS_BY_ACCOUNT_CONVERSATION.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount().filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(),
    touchConversation: (conversationIdRaw, at) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existing) {
        return null;
      }
      const nextRecord: TelegramThreadBindingRecord = {
        ...existing,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, nextRecord);
      persistBindingsToDb({ accountId, persist: manager.shouldPersistMutations() });
      return nextRecord;
    },
    unbindConversation: (unbindParams) => {
      const conversationId = normalizeConversationId(unbindParams.conversationId);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
      if (!removed) {
        return null;
      }
      BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
      persistBindingsToDb({ accountId, persist: manager.shouldPersistMutations() });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: TelegramThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount()) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          conversationId: entry.conversationId,
        });
        BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
        removed.push(entry);
      }
      if (removed.length > 0) {
        persistBindingsToDb({ accountId, persist: manager.shouldPersistMutations() });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({ channel: "telegram", accountId });
      const existingManager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (existingManager === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  registerSessionBindingAdapter({
    channel: "telegram",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "telegram") {
        return null;
      }
      if (input.placement === "child") {
        return null;
      }
      const conversationId = normalizeConversationId(input.conversation.conversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }
      const record = fromSessionBindingInput({
        accountId,
        input: {
          targetSessionKey,
          targetKind: input.targetKind,
          conversationId,
          metadata: input.metadata,
        },
      });
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(
        resolveBindingKey({ accountId, conversationId }),
        record,
      );
      persistBindingsToDb({ accountId, persist: manager.shouldPersistMutations() });
      logVerbose(
        `telegram: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(
          record,
          {
            idleTimeoutMs,
            maxAgeMs,
          },
        )})`,
      );
      return toSessionBindingRecord(record, {
        idleTimeoutMs,
        maxAgeMs,
      });
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return manager.listBySessionKey(targetSessionKey).map((entry) =>
        toSessionBindingRecord(entry, {
          idleTimeoutMs,
          maxAgeMs,
        }),
      );
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== "telegram") {
        return null;
      }
      const conversationId = normalizeConversationId(ref.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = manager.getByConversationId(conversationId);
      return record
        ? toSessionBindingRecord(record, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!conversationId) {
        return;
      }
      manager.touchConversation(conversationId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
          sendFarewell: false,
        });
        return removed.map((entry) =>
          toSessionBindingRecord(entry, {
            idleTimeoutMs,
            maxAgeMs,
          }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation({
        conversationId,
        reason: input.reason,
        sendFarewell: false,
      });
      return removed
        ? [
            toSessionBindingRecord(removed, {
              idleTimeoutMs,
              maxAgeMs,
            }),
          ]
        : [];
    },
  });

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount()) {
        const idleExpired = shouldExpireByIdle({
          now,
          record,
          defaultIdleTimeoutMs: idleTimeoutMs,
        });
        const maxAgeExpired = shouldExpireByMaxAge({
          now,
          record,
          defaultMaxAgeMs: maxAgeMs,
        });
        if (!idleExpired && !maxAgeExpired) {
          continue;
        }
        manager.unbindConversation({
          conversationId: record.conversationId,
          reason: idleExpired ? "idle-expired" : "max-age-expired",
          sendFarewell: false,
        });
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getTelegramThreadBindingManager(
  accountId?: string,
): TelegramThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId)) ?? null;
}

function updateTelegramBindingsBySessionKey(params: {
  manager: TelegramThreadBindingManager;
  targetSessionKey: string;
  update: (entry: TelegramThreadBindingRecord, now: number) => TelegramThreadBindingRecord;
}): TelegramThreadBindingRecord[] {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const now = Date.now();
  const updated: TelegramThreadBindingRecord[] = [];
  for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
    const key = resolveBindingKey({
      accountId: params.manager.accountId,
      conversationId: entry.conversationId,
    });
    const next = params.update(entry, now);
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, next);
    updated.push(next);
  }
  if (updated.length > 0) {
    persistBindingsToDb({
      accountId: params.manager.accountId,
      persist: params.manager.shouldPersistMutations(),
    });
  }
  return updated;
}

export function setTelegramThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): TelegramThreadBindingRecord[] {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return updateTelegramBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      idleTimeoutMs,
      lastActivityAt: now,
    }),
  });
}

export function setTelegramThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): TelegramThreadBindingRecord[] {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return updateTelegramBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      maxAgeMs,
      lastActivityAt: now,
    }),
  });
}

export const __testing = {
  resetTelegramThreadBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
  },
};

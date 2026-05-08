import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import {
  deleteOpenClawStateKvJson,
  listOpenClawStateKvJson,
  writeOpenClawStateKvJson,
} from "../../state/openclaw-state-kv.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

type PersistedCurrentConversationBindingEntry = {
  version: 1;
  binding: SessionBindingRecord;
};

const CURRENT_BINDINGS_FILE_VERSION = 1;
const CURRENT_BINDINGS_KV_SCOPE = "current-conversation-bindings";
const CURRENT_BINDINGS_ID_PREFIX = "generic:";

let bindingsLoaded = false;
const bindingsByConversationKey = new Map<string, SessionBindingRecord>();

function buildConversationKey(ref: ConversationRef): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function buildBindingId(ref: ConversationRef): string {
  return `${CURRENT_BINDINGS_ID_PREFIX}${buildConversationKey(ref)}`;
}

function isBindingExpired(record: SessionBindingRecord, now = Date.now()): boolean {
  return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt <= now
    : false;
}

function toPersistedEntry(record: SessionBindingRecord): PersistedCurrentConversationBindingEntry {
  return {
    version: CURRENT_BINDINGS_FILE_VERSION,
    binding: record,
  };
}

function parsePersistedBindingEntry(value: unknown): SessionBindingRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as PersistedCurrentConversationBindingEntry;
  return record.version === CURRENT_BINDINGS_FILE_VERSION ? record.binding : null;
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  bindingsLoaded = true;
  bindingsByConversationKey.clear();
  const entries =
    listOpenClawStateKvJson<PersistedCurrentConversationBindingEntry>(CURRENT_BINDINGS_KV_SCOPE);
  for (const entry of entries) {
    const record = parsePersistedBindingEntry(entry.value);
    if (!record?.bindingId || !record?.conversation?.conversationId || isBindingExpired(record)) {
      deleteOpenClawStateKvJson(CURRENT_BINDINGS_KV_SCOPE, entry.key);
      continue;
    }
    const conversation = normalizeConversationRef(record.conversation);
    const targetSessionKey = record.targetSessionKey?.trim() ?? "";
    if (!targetSessionKey) {
      continue;
    }
    bindingsByConversationKey.set(buildConversationKey(conversation), {
      ...record,
      bindingId: buildBindingId(conversation),
      targetSessionKey,
      conversation,
    });
  }
}

function persistBinding(record: SessionBindingRecord): void {
  const key = buildConversationKey(record.conversation);
  writeOpenClawStateKvJson(CURRENT_BINDINGS_KV_SCOPE, key, toPersistedEntry(record));
}

function deletePersistedBinding(key: string): void {
  deleteOpenClawStateKvJson(CURRENT_BINDINGS_KV_SCOPE, key);
}

function pruneExpiredBinding(key: string): SessionBindingRecord | null {
  loadBindingsIntoMemory();
  const record = bindingsByConversationKey.get(key) ?? null;
  if (!record) {
    return null;
  }
  if (!isBindingExpired(record)) {
    return record;
  }
  bindingsByConversationKey.delete(key);
  deletePersistedBinding(key);
  return null;
}

function resolveChannelSupportsCurrentConversationBinding(channel: string): boolean {
  const normalized =
    normalizeAnyChannelId(channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(channel));
  if (!normalized) {
    return false;
  }
  const matchesPluginId = (plugin: {
    id?: string | null;
    meta?: { aliases?: readonly string[] } | null;
  }) =>
    plugin.id === normalized ||
    (plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalized,
    );
  // Read the already-installed runtime channel registry from shared state only.
  // Importing plugins/runtime here creates a module cycle through plugin-sdk
  // surfaces during bundled channel discovery.
  const plugin = (getActivePluginChannelRegistryFromState()?.channels ?? []).find((entry) =>
    matchesPluginId(entry.plugin),
  )?.plugin;
  if (plugin?.conversationBindings?.supportsCurrentConversationBinding === true) {
    return true;
  }
  return false;
}

export function getGenericCurrentConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities | null {
  void params.accountId;
  if (!resolveChannelSupportsCurrentConversationBinding(params.channel)) {
    return null;
  }
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current"],
  };
}

export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  loadBindingsIntoMemory();
  const now = Date.now();
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const key = buildConversationKey(conversation);
  const existing = pruneExpiredBinding(key);
  const record: SessionBindingRecord = {
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(ttlMs != null ? { expiresAt: now + ttlMs } : {}),
    metadata: {
      ...existing?.metadata,
      ...input.metadata,
      lastActivityAt: now,
    },
  };
  bindingsByConversationKey.set(key, record);
  persistBinding(record);
  return record;
}

export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  return pruneExpiredBinding(buildConversationKey(ref));
}

export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  loadBindingsIntoMemory();
  const results: SessionBindingRecord[] = [];
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== targetSessionKey) {
      continue;
    }
    results.push(record);
  }
  return results;
}

export function touchGenericCurrentConversationBinding(bindingId: string, at = Date.now()): void {
  loadBindingsIntoMemory();
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return;
  }
  const key = bindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
  const record = pruneExpiredBinding(key);
  if (!record) {
    return;
  }
  bindingsByConversationKey.set(key, {
    ...record,
    metadata: {
      ...record.metadata,
      lastActivityAt: at,
    },
  });
  persistBinding(bindingsByConversationKey.get(key)!);
}

export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  loadBindingsIntoMemory();
  const removed: SessionBindingRecord[] = [];
  const normalizedBindingId = input.bindingId?.trim();
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    const key = normalizedBindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
    const record = pruneExpiredBinding(key);
    if (record) {
      bindingsByConversationKey.delete(key);
      removed.push(record);
      deletePersistedBinding(key);
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== normalizedTargetSessionKey) {
      continue;
    }
    bindingsByConversationKey.delete(key);
    deletePersistedBinding(key);
    removed.push(record);
  }
  return removed;
}

export const __testing = {
  resetCurrentConversationBindingsForTests(params?: {
    deletePersistedFile?: boolean;
    env?: NodeJS.ProcessEnv;
  }) {
    bindingsLoaded = false;
    bindingsByConversationKey.clear();
    if (params?.deletePersistedFile) {
      for (const entry of listOpenClawStateKvJson(CURRENT_BINDINGS_KV_SCOPE, {
        env: params.env,
      })) {
        deleteOpenClawStateKvJson(CURRENT_BINDINGS_KV_SCOPE, entry.key, { env: params.env });
      }
    }
  },
  persistBindingForTests(record: SessionBindingRecord, env?: NodeJS.ProcessEnv) {
    const conversation = normalizeConversationRef(record.conversation);
    const normalized: SessionBindingRecord = {
      ...record,
      bindingId: buildBindingId(conversation),
      conversation,
    };
    writeOpenClawStateKvJson(
      CURRENT_BINDINGS_KV_SCOPE,
      buildConversationKey(conversation),
      {
        version: CURRENT_BINDINGS_FILE_VERSION,
        binding: normalized,
      },
      { env },
    );
  },
  currentBindingsKvScope: CURRENT_BINDINGS_KV_SCOPE,
};

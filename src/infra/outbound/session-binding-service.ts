import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";

export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";
export type SessionBindingPlacement = "current" | "child";
export type SessionBindingErrorCode =
  | "BINDING_ADAPTER_UNAVAILABLE"
  | "BINDING_CAPABILITY_UNSUPPORTED"
  | "BINDING_CREATE_FAILED";

export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  status: BindingStatus;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};

export type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  reason: string;
};

export type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};

export class SessionBindingError extends Error {
  constructor(
    public readonly code: SessionBindingErrorCode,
    message: string,
    public readonly details?: {
      channel?: string;
      accountId?: string;
      placement?: SessionBindingPlacement;
    },
  ) {
    super(message);
    this.name = "SessionBindingError";
  }
}

export function isSessionBindingError(error: unknown): error is SessionBindingError {
  return error instanceof SessionBindingError;
}

export type SessionBindingService = {
  bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
  getCapabilities: (params: { channel: string; accountId: string }) => SessionBindingCapabilities;
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  touch: (bindingId: string, at?: number) => void;
  unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

export type SessionBindingAdapterCapabilities = {
  placements?: SessionBindingPlacement[];
  bindSupported?: boolean;
  unbindSupported?: boolean;
};

export type SessionBindingAdapter = {
  channel: string;
  accountId: string;
  capabilities?: SessionBindingAdapterCapabilities;
  bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  touch?: (bindingId: string, at?: number) => void;
  unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

function normalizeConversationRef(ref: ConversationRef): ConversationRef {
  return {
    channel: ref.channel.trim().toLowerCase(),
    accountId: normalizeAccountId(ref.accountId),
    conversationId: ref.conversationId.trim(),
    parentConversationId: ref.parentConversationId?.trim() || undefined,
  };
}

function toAdapterKey(params: { channel: string; accountId: string }): string {
  return `${params.channel.trim().toLowerCase()}:${normalizeAccountId(params.accountId)}`;
}

function normalizePlacement(raw: unknown): SessionBindingPlacement | undefined {
  return raw === "current" || raw === "child" ? raw : undefined;
}

function inferDefaultPlacement(ref: ConversationRef): SessionBindingPlacement {
  return ref.conversationId ? "current" : "child";
}

function resolveAdapterPlacements(adapter: SessionBindingAdapter): SessionBindingPlacement[] {
  const configured = adapter.capabilities?.placements?.map((value) => normalizePlacement(value));
  const placements = configured?.filter((value): value is SessionBindingPlacement =>
    Boolean(value),
  );
  if (placements && placements.length > 0) {
    return [...new Set(placements)];
  }
  return ["current", "child"];
}

function resolveAdapterCapabilities(
  adapter: SessionBindingAdapter | null,
): SessionBindingCapabilities {
  if (!adapter) {
    return {
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    };
  }
  const bindSupported = adapter.capabilities?.bindSupported ?? Boolean(adapter.bind);
  return {
    adapterAvailable: true,
    bindSupported,
    unbindSupported: adapter.capabilities?.unbindSupported ?? Boolean(adapter.unbind),
    placements: bindSupported ? resolveAdapterPlacements(adapter) : [],
  };
}

const SESSION_BINDING_ADAPTERS_KEY = Symbol.for("openclaw.sessionBinding.adapters");

type SessionBindingAdapterRegistration = {
  adapter: SessionBindingAdapter;
  normalizedAdapter: SessionBindingAdapter;
};

const ADAPTERS_BY_CHANNEL_ACCOUNT = resolveGlobalMap<string, SessionBindingAdapterRegistration[]>(
  SESSION_BINDING_ADAPTERS_KEY,
);

const GENERIC_SESSION_BINDINGS_KEY = Symbol.for("openclaw.sessionBinding.genericBindings");

const GENERIC_BINDINGS_BY_CONVERSATION = resolveGlobalMap<string, SessionBindingRecord>(
  GENERIC_SESSION_BINDINGS_KEY,
);

const GENERIC_BINDING_ID_PREFIX = "generic:";

function getActiveAdapterForKey(key: string): SessionBindingAdapter | null {
  const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
  return registrations?.[0]?.normalizedAdapter ?? null;
}

export function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void {
  const normalizedAdapter = {
    ...adapter,
    channel: adapter.channel.trim().toLowerCase(),
    accountId: normalizeAccountId(adapter.accountId),
  };
  const key = toAdapterKey({
    channel: normalizedAdapter.channel,
    accountId: normalizedAdapter.accountId,
  });
  const existing = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
  const registrations = existing ? [...existing] : [];
  registrations.push({
    adapter,
    normalizedAdapter,
  });
  ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, registrations);
}

export function unregisterSessionBindingAdapter(params: {
  channel: string;
  accountId: string;
  adapter?: SessionBindingAdapter;
}): void {
  const key = toAdapterKey(params);
  const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
  if (!registrations || registrations.length === 0) {
    return;
  }
  const nextRegistrations = [...registrations];
  if (params.adapter) {
    // Remove the matching owner so a surviving duplicate graph can stay active.
    const registrationIndex = nextRegistrations.findLastIndex(
      (registration) => registration.adapter === params.adapter,
    );
    if (registrationIndex < 0) {
      return;
    }
    nextRegistrations.splice(registrationIndex, 1);
  } else {
    nextRegistrations.pop();
  }
  if (nextRegistrations.length === 0) {
    ADAPTERS_BY_CHANNEL_ACCOUNT.delete(key);
    return;
  }
  ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, nextRegistrations);
}

function resolveAdapterForConversation(ref: ConversationRef): SessionBindingAdapter | null {
  return resolveAdapterForChannelAccount({
    channel: ref.channel,
    accountId: ref.accountId,
  });
}

function resolveAdapterForChannelAccount(params: {
  channel: string;
  accountId: string;
}): SessionBindingAdapter | null {
  const key = toAdapterKey({
    channel: params.channel,
    accountId: params.accountId,
  });
  return getActiveAdapterForKey(key);
}

function supportsGenericCurrentConversationBindings(params: {
  channel: string;
  accountId: string;
}): boolean {
  void params.accountId;
  return Boolean(
    normalizeChannelId(params.channel) ||
    normalizeAnyChannelId(params.channel) ||
    getActivePluginChannelRegistry()?.channels.some(
      (entry) => entry.plugin.id === params.channel.trim().toLowerCase(),
    ),
  );
}

function buildGenericConversationKey(ref: ConversationRef): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function buildGenericBindingId(ref: ConversationRef): string {
  return `${GENERIC_BINDING_ID_PREFIX}${buildGenericConversationKey(ref)}`;
}

function isGenericBindingExpired(record: SessionBindingRecord, now = Date.now()): boolean {
  return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt <= now
    : false;
}

function pruneExpiredGenericBinding(key: string): SessionBindingRecord | null {
  const record = GENERIC_BINDINGS_BY_CONVERSATION.get(key) ?? null;
  if (!record) {
    return null;
  }
  if (!isGenericBindingExpired(record)) {
    return record;
  }
  GENERIC_BINDINGS_BY_CONVERSATION.delete(key);
  return null;
}

function bindGenericConversation(input: SessionBindingBindInput): SessionBindingRecord | null {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  const now = Date.now();
  const key = buildGenericConversationKey(conversation);
  const existing = pruneExpiredGenericBinding(key);
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const metadata = {
    ...existing?.metadata,
    ...input.metadata,
    lastActivityAt: now,
  };
  const record: SessionBindingRecord = {
    bindingId: buildGenericBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(ttlMs != null ? { expiresAt: now + ttlMs } : {}),
    metadata,
  };
  GENERIC_BINDINGS_BY_CONVERSATION.set(key, record);
  return record;
}

function listGenericBindingsBySession(targetSessionKey: string): SessionBindingRecord[] {
  const results: SessionBindingRecord[] = [];
  for (const key of GENERIC_BINDINGS_BY_CONVERSATION.keys()) {
    const active = pruneExpiredGenericBinding(key);
    if (!active || active.targetSessionKey !== targetSessionKey) {
      continue;
    }
    results.push(active);
  }
  return results;
}

function resolveGenericBindingByConversation(ref: ConversationRef): SessionBindingRecord | null {
  const key = buildGenericConversationKey(ref);
  return pruneExpiredGenericBinding(key);
}

function touchGenericBinding(bindingId: string, at = Date.now()): void {
  if (!bindingId.startsWith(GENERIC_BINDING_ID_PREFIX)) {
    return;
  }
  const key = bindingId.slice(GENERIC_BINDING_ID_PREFIX.length);
  const record = pruneExpiredGenericBinding(key);
  if (!record) {
    return;
  }
  GENERIC_BINDINGS_BY_CONVERSATION.set(key, {
    ...record,
    metadata: {
      ...record.metadata,
      lastActivityAt: at,
    },
  });
}

function unbindGenericBindings(input: SessionBindingUnbindInput): SessionBindingRecord[] {
  const removed: SessionBindingRecord[] = [];
  const normalizedBindingId = input.bindingId?.trim();
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  if (normalizedBindingId?.startsWith(GENERIC_BINDING_ID_PREFIX)) {
    const key = normalizedBindingId.slice(GENERIC_BINDING_ID_PREFIX.length);
    const record = pruneExpiredGenericBinding(key);
    if (record) {
      GENERIC_BINDINGS_BY_CONVERSATION.delete(key);
      removed.push(record);
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  for (const key of GENERIC_BINDINGS_BY_CONVERSATION.keys()) {
    const active = pruneExpiredGenericBinding(key);
    if (!active || active.targetSessionKey !== normalizedTargetSessionKey) {
      continue;
    }
    GENERIC_BINDINGS_BY_CONVERSATION.delete(key);
    removed.push(active);
  }
  return removed;
}

function getActiveRegisteredAdapters(): SessionBindingAdapter[] {
  return [...ADAPTERS_BY_CHANNEL_ACCOUNT.values()]
    .map((registrations) => registrations[0]?.normalizedAdapter ?? null)
    .filter((adapter): adapter is SessionBindingAdapter => Boolean(adapter));
}

function dedupeBindings(records: SessionBindingRecord[]): SessionBindingRecord[] {
  const byId = new Map<string, SessionBindingRecord>();
  for (const record of records) {
    if (!record?.bindingId) {
      continue;
    }
    byId.set(record.bindingId, record);
  }
  return [...byId.values()];
}

function createDefaultSessionBindingService(): SessionBindingService {
  return {
    bind: async (input) => {
      const normalizedConversation = normalizeConversationRef(input.conversation);
      const adapter = resolveAdapterForConversation(normalizedConversation);
      if (!adapter) {
        if (
          supportsGenericCurrentConversationBindings({
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
          })
        ) {
          const placement =
            normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
          if (placement !== "current") {
            throw new SessionBindingError(
              "BINDING_CAPABILITY_UNSUPPORTED",
              `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
              {
                channel: normalizedConversation.channel,
                accountId: normalizedConversation.accountId,
                placement,
              },
            );
          }
          const bound = bindGenericConversation({
            ...input,
            conversation: normalizedConversation,
            placement,
          });
          if (!bound) {
            throw new SessionBindingError(
              "BINDING_CREATE_FAILED",
              "Session binding adapter failed to bind target conversation",
              {
                channel: normalizedConversation.channel,
                accountId: normalizedConversation.accountId,
                placement,
              },
            );
          }
          return bound;
        }
        throw new SessionBindingError(
          "BINDING_ADAPTER_UNAVAILABLE",
          `Session binding adapter unavailable for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
          {
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
          },
        );
      }
      if (!adapter.bind) {
        throw new SessionBindingError(
          "BINDING_CAPABILITY_UNSUPPORTED",
          `Session binding adapter does not support binding for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
          {
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
          },
        );
      }
      const placement =
        normalizePlacement(input.placement) ?? inferDefaultPlacement(normalizedConversation);
      const supportedPlacements = resolveAdapterPlacements(adapter);
      if (!supportedPlacements.includes(placement)) {
        throw new SessionBindingError(
          "BINDING_CAPABILITY_UNSUPPORTED",
          `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
          {
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
            placement,
          },
        );
      }
      const bound = await adapter.bind({
        ...input,
        conversation: normalizedConversation,
        placement,
      });
      if (!bound) {
        throw new SessionBindingError(
          "BINDING_CREATE_FAILED",
          "Session binding adapter failed to bind target conversation",
          {
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
            placement,
          },
        );
      }
      return bound;
    },
    getCapabilities: (params) => {
      const adapter = resolveAdapterForChannelAccount({
        channel: params.channel,
        accountId: params.accountId,
      });
      if (!adapter && supportsGenericCurrentConversationBindings(params)) {
        return {
          adapterAvailable: true,
          bindSupported: true,
          unbindSupported: true,
          placements: ["current"],
        };
      }
      return resolveAdapterCapabilities(adapter);
    },
    listBySession: (targetSessionKey) => {
      const key = targetSessionKey.trim();
      if (!key) {
        return [];
      }
      const results: SessionBindingRecord[] = [];
      for (const adapter of getActiveRegisteredAdapters()) {
        const entries = adapter.listBySession(key);
        if (entries.length > 0) {
          results.push(...entries);
        }
      }
      results.push(...listGenericBindingsBySession(key));
      return dedupeBindings(results);
    },
    resolveByConversation: (ref) => {
      const normalized = normalizeConversationRef(ref);
      if (!normalized.channel || !normalized.conversationId) {
        return null;
      }
      const adapter = resolveAdapterForConversation(normalized);
      if (!adapter) {
        return resolveGenericBindingByConversation(normalized);
      }
      return adapter.resolveByConversation(normalized);
    },
    touch: (bindingId, at) => {
      const normalizedBindingId = bindingId.trim();
      if (!normalizedBindingId) {
        return;
      }
      for (const adapter of getActiveRegisteredAdapters()) {
        adapter.touch?.(normalizedBindingId, at);
      }
      touchGenericBinding(normalizedBindingId, at);
    },
    unbind: async (input) => {
      const removed: SessionBindingRecord[] = [];
      for (const adapter of getActiveRegisteredAdapters()) {
        if (!adapter.unbind) {
          continue;
        }
        const entries = await adapter.unbind(input);
        if (entries.length > 0) {
          removed.push(...entries);
        }
      }
      removed.push(...unbindGenericBindings(input));
      return dedupeBindings(removed);
    },
  };
}

const DEFAULT_SESSION_BINDING_SERVICE = createDefaultSessionBindingService();

export function getSessionBindingService(): SessionBindingService {
  return DEFAULT_SESSION_BINDING_SERVICE;
}

export const __testing = {
  resetSessionBindingAdaptersForTests() {
    ADAPTERS_BY_CHANNEL_ACCOUNT.clear();
    GENERIC_BINDINGS_BY_CONVERSATION.clear();
  },
  getRegisteredAdapterKeys() {
    return [...ADAPTERS_BY_CHANNEL_ACCOUNT.keys()];
  },
};

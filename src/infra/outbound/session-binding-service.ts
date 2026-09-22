// Session binding service multiplexes channel adapters and the generic current
// conversation store behind one bind/list/resolve/touch/unbind API.
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  testing as genericCurrentConversationBindingTesting,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  requiresRegisteredSessionBindingAdapter,
  resolveGenericCurrentConversationBinding,
  inspectGenericCurrentConversationBinding,
  inspectGenericCurrentConversationBindingAsync,
  resolveGenericCurrentConversationBindingAsync,
  touchGenericCurrentConversationBinding,
  touchGenericCurrentConversationBindingAsync,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import {
  buildChannelAccountKey,
  normalizeConversationRef,
} from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingErrorCode,
  SessionBindingPlacement,
  SessionBindingRecord,
  SessionBindingScope,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

export type {
  BindingTargetKind,
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingPlacement,
  SessionBindingRecord,
  SessionBindingScope,
} from "./session-binding.types.js";

class SessionBindingError extends Error {
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
  /** @deprecated Use touchAsync. Retained through the next Plugin SDK major. */
  touch: (bindingId: string, at?: number, scope?: SessionBindingScope) => void;
  unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

/** Host service with explicit awaited mutations; the legacy structural type stays assignable. */
export type AsyncSessionBindingService = SessionBindingService & {
  inspectByConversationAsync: typeof inspectSessionBindingByConversationAsync;
  resolveByConversationAsync: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  /** Joins the selected adapter's mutation; legacy adapters may still perform synchronous work. */
  touchAsync: (bindingId: string, at?: number, scope?: SessionBindingScope) => Promise<void>;
};

type SessionBindingAdapterCapabilities = {
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
  /** Pure selection for ownership checks; defaults to resolveByConversation for legacy adapters. */
  inspectByConversation?: (ref: ConversationRef) => SessionBindingRecord | null;
  /** Inspects committed ownership without creating storage or pruning rows. */
  inspectByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  resolveByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  /** @deprecated Use touchAsync. Retained through the next Plugin SDK major. */
  touch?: (bindingId: string, at?: number) => void;
  /** Settles accepted persistence before resolving. */
  touchAsync?: (bindingId: string, at?: number) => Promise<void>;
  unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

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
    return uniqueValues(placements);
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

export function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void {
  const normalizedAdapter = {
    ...adapter,
    ...normalizeConversationRef({
      channel: adapter.channel,
      accountId: adapter.accountId,
      conversationId: "unused",
    }),
  };
  const key = buildChannelAccountKey(normalizedAdapter);
  const existing = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
  const registrations = existing ? [...existing] : [];
  // Registrations are stacked so duplicate module graphs can temporarily
  // coexist and unregister without tearing down the active replacement.
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
  const key = buildChannelAccountKey(params);
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

function resolveAdapterForChannelAccount(params: {
  channel: string;
  accountId: string;
}): SessionBindingAdapter | null {
  return (
    ADAPTERS_BY_CHANNEL_ACCOUNT.get(buildChannelAccountKey(params))?.at(-1)?.normalizedAdapter ??
    null
  );
}

/** Revalidates the exact registration, including its original adapter's retained callbacks. */
export function isSessionBindingAdapterCurrent(adapter: SessionBindingAdapter): boolean {
  const registration = ADAPTERS_BY_CHANNEL_ACCOUNT.get(buildChannelAccountKey(adapter))?.at(-1);
  return registration?.adapter === adapter || registration?.normalizedAdapter === adapter;
}

function assertAdapterSelectionCurrent(
  ref: SessionBindingScope,
  adapter: SessionBindingAdapter | null,
) {
  if (
    resolveAdapterForChannelAccount(ref) !== adapter ||
    (!adapter && requiresRegisteredSessionBindingAdapter(ref))
  ) {
    throw new SessionBindingError(
      "BINDING_ADAPTER_UNAVAILABLE",
      `Session binding owner changed for ${ref.channel}:${ref.accountId}`,
      { channel: ref.channel, accountId: ref.accountId },
    );
  }
}

function captureConversationRef(ref: ConversationRef): ConversationRef {
  return normalizeConversationRef({
    channel: ref.channel,
    accountId: ref.accountId,
    conversationId: ref.conversationId,
    ...(ref.parentConversationId !== undefined
      ? { parentConversationId: ref.parentConversationId }
      : {}),
  });
}

function getActiveRegisteredAdapters(scope?: SessionBindingScope): SessionBindingAdapter[] {
  if (scope) {
    const adapter = resolveAdapterForChannelAccount(scope);
    return adapter ? [adapter] : [];
  }
  return [...ADAPTERS_BY_CHANNEL_ACCOUNT.values()]
    .map((registrations) => registrations.at(-1)?.normalizedAdapter ?? null)
    .filter((adapter): adapter is SessionBindingAdapter => Boolean(adapter));
}

function dedupeBindings(records: SessionBindingRecord[]): SessionBindingRecord[] {
  const byId = new Map<string, SessionBindingRecord>();
  for (const record of records) {
    if (!record?.bindingId) {
      continue;
    }
    // Adapter-local ids can coincide across channels/accounts; keep every owner visible.
    byId.set(
      JSON.stringify([buildChannelAccountKey(record.conversation), record.bindingId]),
      record,
    );
  }
  return [...byId.values()];
}

export function inspectSessionBindingByConversation(
  ref: ConversationRef,
): { status: "available"; binding: SessionBindingRecord | null } | { status: "unavailable" } {
  const normalized = normalizeConversationRef(ref);
  if (!normalized.channel || !normalized.conversationId) {
    return { status: "available", binding: null };
  }
  const adapter = resolveAdapterForChannelAccount(normalized);
  if (adapter) {
    return {
      status: "available",
      binding: adapter.inspectByConversation
        ? adapter.inspectByConversation(normalized)
        : adapter.resolveByConversation(normalized),
    };
  }
  // A channel-owned adapter may disappear briefly during restart. That gap is not an
  // authoritative empty result and must not let callers fall through to another owner.
  if (requiresRegisteredSessionBindingAdapter(normalized)) {
    return { status: "unavailable" };
  }
  return {
    status: "available",
    binding: inspectGenericCurrentConversationBinding(normalized),
  };
}

/** Awaits worker-backed ownership inspection; legacy external adapters retain their sync reader. */
async function inspectSessionBindingByConversationAsync(
  ref: ConversationRef,
): Promise<ReturnType<typeof inspectSessionBindingByConversation>> {
  const normalized = captureConversationRef(ref);
  if (!normalized.channel || !normalized.conversationId) {
    return { status: "available", binding: null };
  }
  const adapter = resolveAdapterForChannelAccount(normalized);
  if (!adapter && requiresRegisteredSessionBindingAdapter(normalized)) {
    return { status: "unavailable" };
  }
  const binding = adapter
    ? adapter.inspectByConversationAsync
      ? await adapter.inspectByConversationAsync(normalized)
      : adapter.inspectByConversation
        ? adapter.inspectByConversation(normalized)
        : adapter.resolveByConversation(normalized)
    : await inspectGenericCurrentConversationBindingAsync(normalized);
  if (
    resolveAdapterForChannelAccount(normalized) !== adapter ||
    (!adapter && requiresRegisteredSessionBindingAdapter(normalized))
  ) {
    return { status: "unavailable" };
  }
  return { status: "available", binding };
}

function createDefaultSessionBindingService(): AsyncSessionBindingService {
  return {
    inspectByConversationAsync: inspectSessionBindingByConversationAsync,
    bind: async (input) => {
      const normalizedConversation = normalizeConversationRef(input.conversation);
      const adapter = resolveAdapterForChannelAccount(normalizedConversation);
      const genericCapabilities = adapter
        ? null
        : getGenericCurrentConversationBindingCapabilities(normalizedConversation);
      if (!adapter && !genericCapabilities?.bindSupported) {
        throw new SessionBindingError(
          "BINDING_ADAPTER_UNAVAILABLE",
          `Session binding adapter unavailable for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
          {
            channel: normalizedConversation.channel,
            accountId: normalizedConversation.accountId,
          },
        );
      }
      if (adapter && !adapter.bind) {
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
      const supportedPlacements = adapter
        ? resolveAdapterPlacements(adapter)
        : genericCapabilities!.placements;
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
      const bindInput = {
        ...input,
        conversation: normalizedConversation,
        placement,
      };
      const bound = adapter
        ? await adapter.bind!(bindInput)
        : await bindGenericCurrentConversation(bindInput);
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
      const adapter = resolveAdapterForChannelAccount(params);
      if (!adapter) {
        return (
          getGenericCurrentConversationBindingCapabilities(params) ??
          resolveAdapterCapabilities(null)
        );
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
      results.push(...listGenericCurrentConversationBindingsBySession(key));
      return dedupeBindings(results);
    },
    resolveByConversation: (ref) => {
      const normalized = normalizeConversationRef(ref);
      if (!normalized.channel || !normalized.conversationId) {
        return null;
      }
      const adapter = resolveAdapterForChannelAccount(normalized);
      if (!adapter) {
        return resolveGenericCurrentConversationBinding(normalized);
      }
      return adapter.resolveByConversation(normalized);
    },
    resolveByConversationAsync: async (ref) => {
      const normalized = captureConversationRef(ref);
      if (!normalized.channel || !normalized.conversationId) {
        return null;
      }
      const adapter = resolveAdapterForChannelAccount(normalized);
      assertAdapterSelectionCurrent(normalized, adapter);
      const binding = adapter
        ? adapter.resolveByConversationAsync
          ? await adapter.resolveByConversationAsync(normalized)
          : adapter.resolveByConversation(normalized)
        : await resolveGenericCurrentConversationBindingAsync(normalized, {
            assertCurrent: () => assertAdapterSelectionCurrent(normalized, null),
          });
      assertAdapterSelectionCurrent(normalized, adapter);
      return binding;
    },
    touch: (bindingId, at, scope) => {
      const normalizedBindingId = bindingId.trim();
      if (!normalizedBindingId) {
        return;
      }
      const adapters = getActiveRegisteredAdapters(scope);
      for (const adapter of adapters) {
        adapter.touch?.(normalizedBindingId, at);
      }
      if (!scope || adapters.length === 0) {
        touchGenericCurrentConversationBinding(normalizedBindingId, at, scope);
      }
    },
    touchAsync: async (bindingId, at, scope) => {
      const normalizedBindingId = bindingId.trim();
      if (!normalizedBindingId) {
        return;
      }
      const ownerScope = scope ? { channel: scope.channel, accountId: scope.accountId } : undefined;
      const adapters = getActiveRegisteredAdapters(ownerScope);
      for (const adapter of adapters) {
        // Earlier adapters may await across retirement; never invoke or replace a stale owner.
        if (!isSessionBindingAdapterCurrent(adapter)) {
          continue;
        }
        if (adapter.touchAsync) {
          await adapter.touchAsync(normalizedBindingId, at);
        } else {
          // External adapters keep their synchronous contract during migration.
          adapter.touch?.(normalizedBindingId, at);
        }
      }
      if (!ownerScope || adapters.length === 0) {
        await touchGenericCurrentConversationBindingAsync(normalizedBindingId, at, ownerScope, {
          assertCurrent: (ref) => assertAdapterSelectionCurrent(ref, null),
        });
      }
    },
    unbind: async (input) => {
      const removed: SessionBindingRecord[] = [];
      const adapters = getActiveRegisteredAdapters(input.scope);
      for (const adapter of adapters) {
        if (!adapter.unbind) {
          continue;
        }
        const entries = await adapter.unbind(input);
        if (entries.length > 0) {
          removed.push(...entries);
        }
      }
      if (!input.scope || adapters.length === 0) {
        removed.push(...(await unbindGenericCurrentConversationBindings(input)));
      }
      return dedupeBindings(removed);
    },
  };
}

const DEFAULT_SESSION_BINDING_SERVICE = createDefaultSessionBindingService();

export function getSessionBindingService(): AsyncSessionBindingService {
  return DEFAULT_SESSION_BINDING_SERVICE;
}

export const testing = {
  resetSessionBindingAdaptersForTests() {
    ADAPTERS_BY_CHANNEL_ACCOUNT.clear();
    genericCurrentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
  },
  getRegisteredAdapterKeys() {
    return [...ADAPTERS_BY_CHANNEL_ACCOUNT.keys()];
  },
};

import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveSpawnThreadBindingPlacement } from "../../channels/conversation-resolution.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  testing as genericCurrentConversationBindingTesting,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  listGenericCurrentConversationBindingsBySessionsAsync,
  requiresRegisteredSessionBindingAdapter,
  resolveGenericCurrentConversationBinding,
  captureGenericBindingSupport,
  inspectCurrentConversationBindingRecords,
  inspectGenericCurrentConversationBindingAsync,
  resolveGenericCurrentConversationBindingAsync,
  readGenericCurrentConversationBindingSelectionAsync,
  touchGenericCurrentConversationBinding,
  touchGenericCurrentConversationBindingAsync,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import { CURRENT_BINDINGS_ID_PREFIX } from "./current-conversation-bindings.kernel.js";
import { SessionBindingError } from "./session-binding-errors.js";
import {
  nativeSessionBindingInspection,
  nativeSessionBindingSelection,
  nativeSessionBindingListBySessions,
  type NativeSessionBindingReads,
} from "./session-binding-native-selection.js";
import {
  buildChannelAccountKey,
  captureConversationRef,
  normalizeConversationRef,
  withSessionBindingInspectionConversation,
} from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingInspection,
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

export { isSessionBindingError } from "./session-binding-errors.js";

export type SessionBindingService = {
  bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
  getCapabilities: (params: SessionBindingScope) => SessionBindingCapabilities;
  /** @deprecated Use listBySessionAsync; removed in the next Plugin SDK major. */
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  /** @deprecated Use resolveByConversationAsync. The synchronous form will be removed in the next Plugin SDK major. */
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  /** @deprecated Use touchAsync. The synchronous form will be removed in the next Plugin SDK major. */
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

export type SessionBindingServiceV2 = AsyncSessionBindingService & {
  listBySessionAsync: typeof listSessionBindingsBySessionAsync;
};

type SessionBindingAdapterCapabilities = {
  placements?: SessionBindingPlacement[];
  bindSupported?: boolean;
  unbindSupported?: boolean;
};

/** @deprecated Implement SessionBindingAdapterV2; removed in the next Plugin SDK major. */
export type SessionBindingAdapter = {
  channel: string;
  accountId: string;
  capabilities?: SessionBindingAdapterCapabilities;
  bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
  /** @deprecated Use listBySessionAsync; removed in the next Plugin SDK major. */
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  /** @deprecated Use resolveByConversationAsync. The synchronous form will be removed in the next Plugin SDK major. */
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  /** @deprecated Use inspectByConversationAsync; removed in the next Plugin SDK major. */
  inspectByConversation?: (ref: ConversationRef) => SessionBindingRecord | null;
  /** Inspects committed ownership without creating storage or pruning rows. */
  inspectByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  resolveByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  /** @deprecated Use touchAsync. The synchronous form will be removed in the next Plugin SDK major. */
  touch?: (bindingId: string, at?: number) => void;
  /** Settles accepted persistence before resolving. */
  touchAsync?: (bindingId: string, at?: number) => Promise<void>;
  unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

/** A coherent source-owned selection; its assertion also covers absence and replacement. */
export type SessionBindingSelectionSnapshot = {
  bindings: readonly (SessionBindingRecord | null)[];
  assertCurrent: () => void;
};

/** Awaited adapter contract. Synchronous members serve released SDK consumers only. */
export type SessionBindingAdapterV2 = SessionBindingAdapter & {
  version: 2;
  inspectByConversationsAsync: (
    refs: readonly ConversationRef[],
  ) => Promise<SessionBindingSelectionSnapshot>;
  touchAsync: (bindingId: string, at?: number) => Promise<void>;
  /** Rechecks the original owner after awaited work and before accepting mutations. */
  assertCurrent: () => void;
  listBySessionAsync: (targetSessionKey: string) => Promise<SessionBindingRecord[]>;
  inspectByConversationAsync: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  resolveByConversationAsync: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
};

function isAsyncAdapter(adapter: SessionBindingAdapter): adapter is SessionBindingAdapterV2 {
  return "version" in adapter && adapter.version === 2;
}

function normalizePlacement(raw: unknown): SessionBindingPlacement | undefined {
  return raw === "current" || raw === "child" ? raw : undefined;
}

function resolveAdapterPlacements(adapter: SessionBindingAdapter): SessionBindingPlacement[] {
  const placements = adapter.capabilities?.placements?.filter(
    (value) => normalizePlacement(value) !== undefined,
  );
  return placements?.length ? uniqueValues(placements) : ["current", "child"];
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

type NativeCapableSessionBindingAdapter = (SessionBindingAdapter | SessionBindingAdapterV2) &
  NativeSessionBindingReads;

type SessionBindingAdapterRegistration = {
  adapter: SessionBindingAdapter;
  normalizedAdapter: NativeCapableSessionBindingAdapter;
};

const ADAPTERS_BY_CHANNEL_ACCOUNT = resolveGlobalMap<string, SessionBindingAdapterRegistration[]>(
  SESSION_BINDING_ADAPTERS_KEY,
);

/** @deprecated Use registerSessionBindingAdapterV2; removed in the next Plugin SDK major. */
export function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void {
  warnPluginSdkDeprecation({
    family: "conversation-bindings",
    method: "registerSessionBindingAdapter",
    replacement: "registerSessionBindingAdapterV2",
    compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
  });
  registerAdapter(adapter);
}

function registerAdapter(adapter: SessionBindingAdapter | SessionBindingAdapterV2): void {
  const normalizedAdapter: NativeCapableSessionBindingAdapter = {
    ...adapter,
    ...normalizeConversationRef({
      channel: adapter.channel,
      accountId: adapter.accountId,
      conversationId: "unused",
    }),
  };
  const key = buildChannelAccountKey(normalizedAdapter);
  // Registrations are stacked so duplicate module graphs can temporarily
  // coexist and unregister without tearing down the active replacement.
  const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key) ?? [];
  registrations.push({ adapter, normalizedAdapter });
  ADAPTERS_BY_CHANNEL_ACCOUNT.set(key, registrations);
}

export function registerSessionBindingAdapterV2(adapter: SessionBindingAdapterV2): void {
  registerAdapter(adapter);
}

export function unregisterSessionBindingAdapter(params: {
  channel: string;
  accountId: string;
  adapter?: SessionBindingAdapter;
}): void {
  const key = buildChannelAccountKey(params);
  const registrations = ADAPTERS_BY_CHANNEL_ACCOUNT.get(key);
  if (!registrations?.length) {
    return;
  }
  // Remove the matching owner so a surviving duplicate graph can stay active.
  const registrationIndex = params.adapter
    ? registrations.findLastIndex((registration) => registration.adapter === params.adapter)
    : registrations.length - 1;
  if (registrationIndex < 0) {
    return;
  }
  registrations.splice(registrationIndex, 1);
  if (registrations.length === 0) {
    ADAPTERS_BY_CHANNEL_ACCOUNT.delete(key);
  }
}

function resolveAdapterForChannelAccount(
  params: SessionBindingScope,
): NativeCapableSessionBindingAdapter | null {
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
  if (adapter && isAsyncAdapter(adapter)) {
    adapter.assertCurrent();
  }
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

/**
 * Workers spawned before child-only placement could bind the conversation a user was
 * talking in. Those persisted bindings stay invisible, so the conversation routes to its
 * normal agent; untouched, they expire through their owner's idle/max-age lifecycle.
 */
function routableBinding(record: SessionBindingRecord | null): SessionBindingRecord | null {
  if (record?.metadata?.boundBy !== "system") {
    return record;
  }
  const adapter = resolveAdapterForChannelAccount(record.conversation);
  // The generic current-conversation store never offers child placement.
  const placements = adapter ? resolveAdapterCapabilities(adapter).placements : [];
  return resolveSpawnThreadBindingPlacement(record.conversation.channel, placements) === "child"
    ? record
    : null;
}

function getActiveRegisteredAdapters(
  scope?: SessionBindingScope,
): NativeCapableSessionBindingAdapter[] {
  if (scope) {
    const adapter = resolveAdapterForChannelAccount(scope);
    return adapter ? [adapter] : [];
  }
  return [...ADAPTERS_BY_CHANNEL_ACCOUNT.values()].flatMap(
    (registrations) => registrations.at(-1)?.normalizedAdapter ?? [],
  );
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

/** Internal destination enumeration; the shipped synchronous SDK service remains unchanged. */
export async function listSessionBindingsBySessionsAsync(
  targetSessionKeys: readonly string[],
): Promise<Map<string, SessionBindingRecord[]>> {
  const keys = uniqueValues(targetSessionKeys.map((key) => key.trim()).filter(Boolean));
  if (keys.length === 0) {
    return new Map();
  }
  const context = captureOpenClawStateWorkerContext();
  const adapters = getActiveRegisteredAdapters();
  const prepared = new Map<NativeCapableSessionBindingAdapter, SessionBindingRecord[][]>();
  for (const adapter of adapters) {
    const nativeList = adapter[nativeSessionBindingListBySessions];
    if (!nativeList && !isAsyncAdapter(adapter)) {
      continue;
    }
    if (isAsyncAdapter(adapter)) {
      adapter.assertCurrent();
    }
    const records = nativeList
      ? await nativeList.call(adapter, keys, context)
      : isAsyncAdapter(adapter)
        ? await Promise.all(keys.map((key) => adapter.listBySessionAsync(key)))
        : [];
    if (isAsyncAdapter(adapter)) {
      adapter.assertCurrent();
    }
    if (records.length !== keys.length) {
      throw new Error("Session binding owner returned an incomplete session listing");
    }
    prepared.set(adapter, records);
  }
  const generic = await listGenericCurrentConversationBindingsBySessionsAsync(keys, context);
  return new Map(
    keys.map((key, index) => {
      const results: SessionBindingRecord[] = [];
      for (const adapter of adapters) {
        // External adapters retain their released synchronous projection contract.
        const entries = prepared.has(adapter)
          ? prepared.get(adapter)![index]!
          : adapter.listBySession(key);
        results.push(...entries);
      }
      results.push(...(generic[index] ?? []));
      return [key, dedupeBindings(results).filter((record) => routableBinding(record))];
    }),
  );
}

export async function listSessionBindingsBySessionAsync(
  targetSessionKey: string,
): Promise<SessionBindingRecord[]> {
  return (
    (await listSessionBindingsBySessionsAsync([targetSessionKey])).get(targetSessionKey.trim()) ??
    []
  );
}

/** @deprecated Use inspectSessionBindingByConversationAsync; removed in the next Plugin SDK major. */
export function inspectSessionBindingByConversation(
  ref: ConversationRef,
): SessionBindingInspection {
  warnPluginSdkDeprecation({
    family: "conversation-bindings",
    method: "inspectSessionBindingByConversation",
    replacement: "inspectSessionBindingByConversationAsync",
    compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
  });
  return inspectSessionBindingsByConversations([ref])[0]!;
}

/** One synchronous owner view per phase; no selection survives a wait or a later grant. */
export function inspectSessionBindingsByConversations(
  refs: readonly ConversationRef[],
): SessionBindingInspection[] {
  const nativeRefs: ConversationRef[] = [];
  const selections = refs.map((ref) => {
    const conversation = captureConversationRef(ref);
    if (!conversation.channel || !conversation.conversationId) {
      return () => ({ status: "available" as const, binding: null });
    }
    const adapter = resolveAdapterForChannelAccount(conversation);
    const native = adapter?.[nativeSessionBindingInspection];
    if (adapter && !native) {
      const record = (adapter.inspectByConversation || adapter.resolveByConversation).call(
        adapter,
        conversation,
      );
      return () => {
        assertAdapterSelectionCurrent(conversation, adapter);
        return availableBindingInspection(conversation, record);
      };
    }
    if (!adapter && requiresRegisteredSessionBindingAdapter(conversation)) {
      return () =>
        withSessionBindingInspectionConversation({ status: "unavailable" as const }, conversation);
    }
    const generic = adapter ? undefined : captureGenericBindingSupport(conversation);
    native?.assertCurrent();
    const captured = native
      ? native.capture(conversation)
      : generic?.supported
        ? conversation
        : null;
    const index = captured ? nativeRefs.push(captured) - 1 : -1;
    return (records: ReadonlyArray<SessionBindingRecord | null>) => {
      assertAdapterSelectionCurrent(conversation, adapter);
      native?.assertCurrent();
      generic?.assertCurrent();
      const record = index >= 0 ? (records[index] ?? null) : null;
      return availableBindingInspection(
        conversation,
        !adapter && !record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? null : record,
      );
    };
  });
  const records = inspectCurrentConversationBindingRecords(nativeRefs);
  return selections.map((select) => select(records));
}

function availableBindingInspection(
  conversation: ConversationRef,
  binding: SessionBindingRecord | null,
) {
  return withSessionBindingInspectionConversation(
    { status: "available" as const, binding: routableBinding(binding) },
    conversation,
  );
}

/** Awaits worker-backed ownership inspection; legacy external adapters retain their sync reader. */
export async function inspectSessionBindingByConversationAsync(
  ref: ConversationRef,
): Promise<ReturnType<typeof inspectSessionBindingByConversation>> {
  const normalized = captureConversationRef(ref);
  if (!normalized.channel || !normalized.conversationId) {
    return { status: "available", binding: null };
  }
  const adapter = resolveAdapterForChannelAccount(normalized);
  if (!adapter && requiresRegisteredSessionBindingAdapter(normalized)) {
    return withSessionBindingInspectionConversation({ status: "unavailable" as const }, normalized);
  }
  if (adapter && isAsyncAdapter(adapter)) {
    adapter.assertCurrent();
  }
  let snapshot: SessionBindingSelectionSnapshot | undefined;
  const binding = adapter
    ? isAsyncAdapter(adapter)
      ? ((snapshot = await adapter.inspectByConversationsAsync([normalized])).bindings[0] ?? null)
      : adapter.inspectByConversationAsync
        ? await adapter.inspectByConversationAsync(normalized)
        : (adapter.inspectByConversation || adapter.resolveByConversation).call(adapter, normalized)
    : await inspectGenericCurrentConversationBindingAsync(normalized);
  if (
    resolveAdapterForChannelAccount(normalized) !== adapter ||
    (!adapter && requiresRegisteredSessionBindingAdapter(normalized))
  ) {
    return withSessionBindingInspectionConversation({ status: "unavailable" as const }, normalized);
  }
  if (adapter && isAsyncAdapter(adapter)) {
    adapter.assertCurrent();
  }
  snapshot?.assertCurrent();
  return availableBindingInspection(normalized, binding);
}

/** Legacy adapters retain their synchronous owner view after asynchronous preparation. */
async function readLegacyAdapterSelection(
  adapter: SessionBindingAdapter,
  conversations: readonly ConversationRef[],
  assertCurrent: () => void,
): Promise<ReadonlyArray<SessionBindingRecord | null>> {
  const prepare =
    adapter.inspectByConversationAsync ??
    (adapter.inspectByConversation ? undefined : adapter.resolveByConversationAsync);
  if (prepare) {
    for (const conversation of conversations) {
      await prepare.call(adapter, { ...conversation });
      assertCurrent();
    }
  }
  // No await may split this view: a higher-priority absence and its fallback
  // must describe the same current owner state.
  const inspect = adapter.inspectByConversation ?? adapter.resolveByConversation;
  const records = conversations.map((conversation) => inspect.call(adapter, { ...conversation }));
  assertCurrent();
  return records;
}

/** Internal admission read; public scalar SDK APIs keep their existing contracts. */
export async function readSessionBindingSelectionCurrent(
  refs: readonly ConversationRef[],
): Promise<ReadonlyArray<SessionBindingRecord | null>> {
  const conversations = refs.map(captureConversationRef);
  const first = conversations[0];
  if (!first) {
    return [];
  }
  const adapter = resolveAdapterForChannelAccount(first);
  const assertCurrent = () => {
    for (const conversation of conversations) {
      assertAdapterSelectionCurrent(conversation, adapter);
    }
  };
  assertCurrent();
  const nativeRead = adapter?.[nativeSessionBindingSelection];
  let snapshot: SessionBindingSelectionSnapshot | undefined;
  const records = !adapter
    ? await readGenericCurrentConversationBindingSelectionAsync(conversations, { assertCurrent })
    : nativeRead
      ? await nativeRead.call(adapter, conversations)
      : isAsyncAdapter(adapter)
        ? (snapshot = await adapter.inspectByConversationsAsync(conversations)).bindings
        : await readLegacyAdapterSelection(adapter, conversations, assertCurrent);
  assertCurrent();
  snapshot?.assertCurrent();
  if (records.length !== conversations.length) {
    throw new Error("Session binding owner returned an incomplete conversation selection");
  }
  return records.map(routableBinding);
}

const DEFAULT_SESSION_BINDING_SERVICE: SessionBindingServiceV2 = {
  listBySessionAsync: listSessionBindingsBySessionAsync,
  inspectByConversationAsync: inspectSessionBindingByConversationAsync,
  bind: async (input) => {
    const assertCurrent = input.assertCurrent;
    const normalizedConversation = normalizeConversationRef(input.conversation);
    const scope = {
      channel: normalizedConversation.channel,
      accountId: normalizedConversation.accountId,
    };
    const adapter = resolveAdapterForChannelAccount(normalizedConversation);
    const genericCapabilities = adapter
      ? null
      : getGenericCurrentConversationBindingCapabilities(normalizedConversation);
    if (adapter ? !adapter.bind : !genericCapabilities?.bindSupported) {
      throw new SessionBindingError(
        adapter ? "BINDING_CAPABILITY_UNSUPPORTED" : "BINDING_ADAPTER_UNAVAILABLE",
        `Session binding adapter ${adapter ? "does not support binding" : "unavailable"} for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
        scope,
      );
    }
    const placement =
      normalizePlacement(input.placement) ??
      (normalizedConversation.conversationId ? "current" : "child");
    const supportedPlacements = adapter
      ? resolveAdapterPlacements(adapter)
      : genericCapabilities!.placements;
    if (!supportedPlacements.includes(placement)) {
      throw new SessionBindingError(
        "BINDING_CAPABILITY_UNSUPPORTED",
        `Session binding placement "${placement}" is not supported for ${normalizedConversation.channel}:${normalizedConversation.accountId}`,
        { ...scope, placement },
      );
    }
    const assertBindingCurrent = () => {
      assertCurrent?.();
      assertAdapterSelectionCurrent(normalizedConversation, adapter);
    };
    const bindInput = {
      ...input,
      conversation: normalizedConversation,
      placement,
      assertCurrent: assertBindingCurrent,
    };
    assertBindingCurrent();
    const bound = adapter
      ? await adapter.bind!(bindInput)
      : await bindGenericCurrentConversation(bindInput);
    if (!bound) {
      throw new SessionBindingError(
        "BINDING_CREATE_FAILED",
        "Session binding adapter failed to bind target conversation",
        { ...scope, placement },
      );
    }
    return bound;
  },
  getCapabilities: (params) => {
    const adapter = resolveAdapterForChannelAccount(params);
    return adapter
      ? resolveAdapterCapabilities(adapter)
      : (getGenericCurrentConversationBindingCapabilities(params) ??
          resolveAdapterCapabilities(null));
  },
  listBySession: (targetSessionKey) => {
    warnPluginSdkDeprecation({
      family: "conversation-bindings",
      method: "SessionBindingService.listBySession",
      replacement: "SessionBindingService.listBySessionAsync",
      compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
    });
    const key = targetSessionKey.trim();
    if (!key) {
      return [];
    }
    const results: SessionBindingRecord[] = [];
    for (const adapter of getActiveRegisteredAdapters()) {
      results.push(...adapter.listBySession(key));
    }
    results.push(...listGenericCurrentConversationBindingsBySession(key));
    return dedupeBindings(results).filter((record) => routableBinding(record));
  },
  resolveByConversation: (ref) => {
    warnPluginSdkDeprecation({
      family: "conversation-bindings",
      method: "SessionBindingService.resolveByConversation",
      replacement: "SessionBindingService.resolveByConversationAsync",
      compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
    });
    const normalized = normalizeConversationRef(ref);
    if (!normalized.channel || !normalized.conversationId) {
      return null;
    }
    const adapter = resolveAdapterForChannelAccount(normalized);
    return routableBinding(
      adapter
        ? adapter.resolveByConversation(normalized)
        : resolveGenericCurrentConversationBinding(normalized),
    );
  },
  resolveByConversationAsync: async (ref) => {
    const normalized = captureConversationRef(ref);
    if (!normalized.channel || !normalized.conversationId) {
      return null;
    }
    const adapter = resolveAdapterForChannelAccount(normalized);
    assertAdapterSelectionCurrent(normalized, adapter);
    const binding = adapter
      ? isAsyncAdapter(adapter) || adapter.resolveByConversationAsync
        ? await adapter.resolveByConversationAsync!(normalized)
        : adapter.resolveByConversation(normalized)
      : await resolveGenericCurrentConversationBindingAsync(normalized, {
          assertCurrent: () => assertAdapterSelectionCurrent(normalized, null),
        });
    assertAdapterSelectionCurrent(normalized, adapter);
    return routableBinding(binding);
  },
  touch: (bindingId, at, scope) => {
    warnPluginSdkDeprecation({
      family: "conversation-bindings",
      method: "SessionBindingService.touch",
      replacement: "SessionBindingService.touchAsync",
      compatibility: "Synchronous binding operations retain commit-before-return compatibility.",
    });
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
      if (isAsyncAdapter(adapter) || adapter.touchAsync) {
        await adapter.touchAsync!(normalizedBindingId, at);
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
    const captured = { ...input, scope: input.scope ? { ...input.scope } : undefined };
    const adapters = getActiveRegisteredAdapters(captured.scope);
    for (const adapter of adapters) {
      assertAdapterSelectionCurrent(adapter, adapter);
      if (adapter.unbind) {
        removed.push(...(await adapter.unbind(captured)));
      }
    }
    if (!captured.scope || adapters.length === 0) {
      removed.push(...(await unbindGenericCurrentConversationBindings(captured)));
    }
    return dedupeBindings(removed);
  },
};

export function getSessionBindingService(): SessionBindingServiceV2 {
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

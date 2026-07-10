import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import {
  DEFAULT_AGENT_ID,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const MAX_STORED_SESSIONS = 20;
const MAX_STORED_QUEUE_ITEMS = 50;
// Shipped v1 state could hold one full queue under each of 20 alias keys.
// Alias consolidation may exceed today's admission cap, but must retain every
// existing input while the canonical queue drains back below 50.
const MAX_RETAINED_QUEUE_ITEMS = MAX_STORED_SESSIONS * MAX_STORED_QUEUE_ITEMS;
const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
let lastIssuedDraftRevision = 0;
export const INTERRUPTED_SETTINGS_WAIT_ERROR =
  "Chat settings update was interrupted. Review and retry when ready.";
export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

type ChatComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
};

export type ChatComposerScope = Pick<
  ChatComposerPersistenceState,
  "settings" | "assistantAgentId" | "agentsList" | "hello"
>;

type StoredComposerSession = {
  draft?: string;
  draftRevision?: number;
  queue?: ChatQueueItem[];
  updatedAt: number;
};

type StoredComposerState = {
  version: 1;
  sessions: Record<string, StoredComposerSession>;
};

type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

type ComposerStorageScope = {
  conversationKey: string;
  agentScope: string;
  routingAgentId?: string;
  isGlobal: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

export type StoredChatOutbox = StoredChatOutboxScope & {
  queue: ChatQueueItem[];
};

export type ChatComposerDraftRetry = {
  expectedDraftRevision: number;
  draftRevision: number;
};

type ChatComposerPersistStatus = "persisted" | "conflict" | "storage-failed";

export type ChatComposerPersistResult =
  | { status: "persisted" }
  | { status: "conflict" }
  | ({ status: "storage-failed" } & ChatComposerDraftRetry);

type ChatComposerPersistOptions = {
  agentId?: string;
  draft?: string;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

function storageKeyForGateway(gatewayUrl: string | null | undefined): string {
  const scope = gatewayUrl?.trim() || "default";
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scope).slice(0, 240)}`;
}

function isBareGlobalAlias(state: ChatComposerScope, sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  return normalized === "main" || normalized === resolveUiConfiguredMainKey(state);
}

function isComposerGlobalScope(state: ChatComposerScope, sessionKey: string): boolean {
  return (
    isUiGlobalSessionKey(sessionKey) ||
    isBareGlobalAlias(state, sessionKey) ||
    resolveUiGlobalAliasAgentId(state, sessionKey) !== null
  );
}

function resolveComposerStorageScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): ComposerStorageScope {
  const isGlobal = isComposerGlobalScope(state, sessionKey);
  const parsed = parseAgentSessionKey(sessionKey);
  const explicitAgentId = parsed?.agentId ?? agentIdOverride?.trim();
  const knownAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  const routingAgentId = isGlobal
    ? explicitAgentId
      ? normalizeAgentId(explicitAgentId)
      : knownAgentId
        ? normalizeAgentId(knownAgentId)
        : undefined
    : parsed?.agentId
      ? normalizeAgentId(parsed.agentId)
      : undefined;
  const agentScope =
    routingAgentId ?? (isGlobal ? UNRESOLVED_GLOBAL_AGENT_SCOPE : DEFAULT_AGENT_ID);
  return {
    conversationKey: isGlobal ? "global" : sessionKey,
    agentScope,
    ...(routingAgentId ? { routingAgentId } : {}),
    isGlobal,
  };
}

function storageSessionKeyForAgentScope(sessionKey: string, agentScope: string): string {
  return `${sessionKey}\u0000agent:${agentScope}`;
}

export function resolveStoredChatOutboxScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): StoredChatOutboxScope {
  const scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride);
  return {
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

export function storedChatOutboxScopeKey(scope: StoredChatOutboxScope): string {
  const agentScope =
    scope.agentId ??
    (scope.sessionKey === "global" ? UNRESOLVED_GLOBAL_AGENT_SCOPE : DEFAULT_AGENT_ID);
  return storageSessionKeyForAgentScope(scope.sessionKey, agentScope);
}

function nextDraftRevision(baseline = 0): number {
  const revision = Math.max(Date.now(), lastIssuedDraftRevision + 1, baseline + 1);
  lastIssuedDraftRevision = revision;
  return revision;
}

function mergeStoredComposerSessions(
  current: StoredComposerSession | null,
  incoming: StoredComposerSession,
): StoredComposerSession {
  if (!current) {
    return incoming;
  }
  // Incoming rows are visited in storage insertion order, so they win a
  // millisecond timestamp tie instead of letting an older canonical row mask a
  // just-written alias or unresolved draft.
  const newest = current.updatedAt > incoming.updatedAt ? current : incoming;
  const older = newest === current ? incoming : current;
  const currentDraftRevision = current.draftRevision;
  const incomingDraftRevision = incoming.draftRevision;
  const newestDraftOwner =
    currentDraftRevision === undefined
      ? incomingDraftRevision === undefined
        ? null
        : incoming
      : incomingDraftRevision === undefined
        ? current
        : currentDraftRevision > incomingDraftRevision
          ? current
          : incoming;
  const queueById = new Map(
    [...(older.queue ?? []), ...(newest.queue ?? [])].map((item) => [item.id, item]),
  );
  const queue = Array.from(queueById.values())
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_RETAINED_QUEUE_ITEMS);
  return {
    ...(newestDraftOwner?.draft ? { draft: newestDraftOwner.draft } : {}),
    ...(newestDraftOwner?.draftRevision !== undefined
      ? { draftRevision: newestDraftOwner.draftRevision }
      : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}

function resolveStoredComposerSession(
  store: StoredComposerState,
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): { session: StoredComposerSession | null; storeSessionKey: string; migrated: boolean } {
  const scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride);
  const storeSessionKey = storageSessionKeyForAgentScope(scope.conversationKey, scope.agentScope);
  let session = normalizeStoredSession(store.sessions[storeSessionKey]);
  let migrated = false;
  const agentSuffix = `\u0000agent:${scope.agentScope}`;
  for (const legacySessionKey of Object.keys(store.sessions)) {
    if (legacySessionKey === storeSessionKey || !legacySessionKey.endsWith(agentSuffix)) {
      continue;
    }
    const legacyRawSessionKey = legacySessionKey.slice(0, -agentSuffix.length);
    const legacyScope = resolveComposerStorageScope(
      state,
      legacyRawSessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    if (legacyScope.conversationKey !== scope.conversationKey) {
      continue;
    }
    const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
    if (legacySession) {
      session = mergeStoredComposerSessions(session, legacySession);
      store.sessions[storeSessionKey] = session;
      delete store.sessions[legacySessionKey];
      migrated = true;
    }
  }
  if (!scope.isGlobal) {
    return { session, storeSessionKey, migrated };
  }
  const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  if (!selectedGlobalAgentId || scope.agentScope !== selectedGlobalAgentId) {
    return { session, storeSessionKey, migrated };
  }
  const unresolvedKey = storageSessionKeyForAgentScope(
    scope.conversationKey,
    UNRESOLVED_GLOBAL_AGENT_SCOPE,
  );
  if (storeSessionKey === unresolvedKey) {
    return { session, storeSessionKey, migrated };
  }
  const unresolved = normalizeStoredSession(store.sessions[unresolvedKey]);
  if (!unresolved) {
    return { session, storeSessionKey, migrated };
  }
  const resolvedUnscopedQueue = unresolved.queue?.map((item) =>
    item.agentId ? item : { ...item, agentId: scope.agentScope },
  );
  const merged = mergeStoredComposerSessions(session, {
    ...unresolved,
    ...(resolvedUnscopedQueue ? { queue: resolvedUnscopedQueue } : {}),
  });
  store.sessions[storeSessionKey] = merged;
  delete store.sessions[unresolvedKey];
  return { session: merged, storeSessionKey, migrated: true };
}

function readStore(storage: Storage, key: string): StoredComposerState {
  const raw = storage.getItem(key);
  if (!raw) {
    return { version: 1, sessions: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredComposerState>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.sessions ||
      typeof parsed.sessions !== "object"
    ) {
      return { version: 1, sessions: {} };
    }
    const sessions: Record<string, StoredComposerSession> = {};
    for (const [sessionKey, value] of Object.entries(parsed.sessions)) {
      const session = normalizeStoredSession(value);
      if (session) {
        sessions[sessionKey] = session;
        lastIssuedDraftRevision = Math.max(lastIssuedDraftRevision, session.draftRevision ?? 0);
      }
    }
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeStore(storage: Storage, key: string, store: StoredComposerState): void {
  const entries = Object.entries(store.sessions);
  const outboxes = entries.filter(([, session]) => session.queue?.length);
  if (outboxes.length > MAX_STORED_SESSIONS) {
    throw new Error("Chat outbox session limit reached");
  }
  const drafts = entries.filter(([, session]) => !session.queue?.length);
  const byNewest = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    b[1].updatedAt - a[1].updatedAt;
  const retained = [...outboxes.toSorted(byNewest), ...drafts.toSorted(byNewest)].slice(
    0,
    MAX_STORED_SESSIONS,
  );
  if (retained.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ version: 1, sessions: Object.fromEntries(retained) }));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const mimeType = normalizeOptionalString(entry.mimeType);
  if (!id || !mimeType) {
    return null;
  }
  const restored: ChatAttachment = { id, mimeType };
  const fileName = normalizeOptionalString(entry.fileName);
  if (fileName) {
    restored.fileName = fileName;
  }
  if (typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)) {
    restored.sizeBytes = entry.sizeBytes;
  }
  const dataUrl = normalizeOptionalString(entry.dataUrl);
  if (dataUrl) {
    restored.dataUrl = dataUrl;
  }
  return restored;
}

function serializeChatAttachment(attachment: ChatAttachment): ChatAttachment | null {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  if (!dataUrl) {
    return null;
  }
  return {
    id: attachment.id,
    mimeType: attachment.mimeType,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
    dataUrl,
  };
}

function normalizeSkillWorkshopRevision(
  value: unknown,
): ChatQueueSkillWorkshopRevision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const proposalId = normalizeOptionalString(entry.proposalId);
  if (!proposalId) {
    return undefined;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  return {
    proposalId,
    ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}),
  };
}

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  const id = normalizeOptionalString(item.id);
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || (!text.trim() && !item.attachments?.length)) {
    return null;
  }
  if (item.pendingRunId) {
    return null;
  }
  if (item.sendState === "sending" && !item.sendRunId) {
    return null;
  }
  const attachments = item.attachments?.map(serializeChatAttachment) ?? [];
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  const sendState =
    item.sendState === "sending"
      ? "waiting-reconnect"
      : item.sendState === "executing-command"
        ? "unconfirmed"
        : item.sendState === "waiting-model"
          ? "failed"
          : item.sendState === "failed" ||
              item.sendState === "unconfirmed" ||
              item.sendState === "waiting-idle" ||
              item.sendState === "waiting-reconnect"
            ? item.sendState
            : undefined;
  const sendError =
    item.sendState === "waiting-model" ? INTERRUPTED_SETTINGS_WAIT_ERROR : item.sendError;
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(item.skillWorkshopRevision);
  return {
    id,
    text,
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    ...(item.kind === "queued" || item.kind === "steered" ? { kind: item.kind } : {}),
    ...(attachments.length ? { attachments: attachments as ChatAttachment[] } : {}),
    ...(typeof item.refreshSessions === "boolean" ? { refreshSessions: item.refreshSessions } : {}),
    ...(item.localCommandArgs ? { localCommandArgs: item.localCommandArgs } : {}),
    ...(item.localCommandName ? { localCommandName: item.localCommandName } : {}),
    ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
    ...(sendState ? { sendState } : {}),
    ...(sendError ? { sendError } : {}),
    ...(item.sendRunId ? { sendRunId: item.sendRunId } : {}),
    ...(typeof item.sendAttempts === "number" && Number.isFinite(item.sendAttempts)
      ? { sendAttempts: item.sendAttempts }
      : {}),
  };
}

function normalizeQueueItem(value: unknown): ChatQueueItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const text = typeof entry.text === "string" ? entry.text : "";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  if (!id || (!text.trim() && !Array.isArray(entry.attachments))) {
    return null;
  }
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments
        .map(normalizeChatAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const item: ChatQueueItem = { id, text, createdAt };
  if (entry.kind === "queued" || entry.kind === "steered") {
    item.kind = entry.kind;
  }
  if (attachments.length) {
    item.attachments = attachments;
  }
  const refreshSessions = normalizeOptionalBoolean(entry.refreshSessions);
  if (refreshSessions !== undefined) {
    item.refreshSessions = refreshSessions;
  }
  if (
    entry.sendState === "failed" ||
    entry.sendState === "unconfirmed" ||
    entry.sendState === "waiting-idle" ||
    entry.sendState === "waiting-reconnect"
  ) {
    item.sendState = entry.sendState;
  } else if (entry.sendState === "waiting-model") {
    item.sendState = "failed";
    item.sendError = INTERRUPTED_SETTINGS_WAIT_ERROR;
  }
  const sendError = normalizeOptionalString(entry.sendError);
  if (sendError) {
    item.sendError = sendError;
  }
  const sendRunId = normalizeOptionalString(entry.sendRunId);
  if (sendRunId) {
    item.sendRunId = sendRunId;
  }
  if (typeof entry.sendAttempts === "number" && Number.isFinite(entry.sendAttempts)) {
    item.sendAttempts = entry.sendAttempts;
  }
  const localCommandArgs = normalizeOptionalString(entry.localCommandArgs);
  if (localCommandArgs) {
    item.localCommandArgs = localCommandArgs;
  }
  const localCommandName = normalizeOptionalString(entry.localCommandName);
  if (localCommandName) {
    item.localCommandName = localCommandName;
  }
  const sessionKey = normalizeOptionalString(entry.sessionKey);
  if (sessionKey) {
    item.sessionKey = sessionKey;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  if (agentId) {
    item.agentId = normalizeAgentId(agentId);
  }
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(entry.skillWorkshopRevision);
  if (skillWorkshopRevision) {
    item.skillWorkshopRevision = skillWorkshopRevision;
  }
  return item;
}

function normalizeStoredSession(value: unknown): StoredComposerSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const draft = typeof entry.draft === "string" ? entry.draft : undefined;
  const normalizedQueue = Array.isArray(entry.queue)
    ? entry.queue
        .slice(0, MAX_RETAINED_QUEUE_ITEMS)
        .map(normalizeQueueItem)
        .filter((item): item is ChatQueueItem => item !== null)
    : undefined;
  // v1 writers used bounded tombstones. Consume them while reading legacy
  // state, but never copy them into the item-level outbox representation.
  const removedQueueItemIds = Array.isArray(entry.removedQueueItemIds)
    ? entry.removedQueueItemIds
        .map(normalizeOptionalString)
        .filter((id): id is string => id !== undefined)
    : undefined;
  const removedIds = new Set(removedQueueItemIds ?? []);
  const queue = normalizedQueue?.filter((item) => !removedIds.has(item.id));
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const storedDraftRevision =
    typeof entry.draftRevision === "number" && Number.isSafeInteger(entry.draftRevision)
      ? entry.draftRevision
      : undefined;
  // Legacy rows did not version drafts, so their row timestamp is the best
  // available ordering signal. Queue-only rows must not claim draft ownership.
  const draftRevision = storedDraftRevision ?? (draft ? updatedAt : undefined);
  if (!draft && draftRevision === undefined && (!queue || queue.length === 0)) {
    return null;
  }
  return {
    ...(draft ? { draft } : {}),
    ...(draftRevision !== undefined ? { draftRevision } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    updatedAt,
  };
}

function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: ComposerStorageScope,
): ChatQueueItem | null {
  const serialized = serializeQueueItem(item);
  if (!serialized) {
    return null;
  }
  const { agentId: _agentId, ...withoutAgentId } = serialized;
  return {
    ...withoutAgentId,
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

function queueItemVersionMatches(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: ComposerStorageScope,
): boolean {
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(
    canonicalExpected &&
    stored.id === canonicalExpected.id &&
    stored.sendRunId === canonicalExpected.sendRunId &&
    stored.sendAttempts === canonicalExpected.sendAttempts &&
    stored.sendState === canonicalExpected.sendState &&
    stored.agentId === canonicalExpected.agentId &&
    stored.sessionKey === canonicalExpected.sessionKey,
  );
}

function queueItemsEqual(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: ComposerStorageScope,
): boolean {
  const canonicalStored = serializeQueueItemForScope(stored, scope);
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(
    canonicalStored &&
    canonicalExpected &&
    JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}

function writeStoredComposerSession(
  store: StoredComposerState,
  storeSessionKey: string,
  session: StoredComposerSession | null,
  queue: ChatQueueItem[],
): void {
  if (!session?.draft && session?.draftRevision === undefined && queue.length === 0) {
    delete store.sessions[storeSessionKey];
    return;
  }
  store.sessions[storeSessionKey] = {
    ...(session?.draft ? { draft: session.draft } : {}),
    ...(session?.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

export function loadChatComposerDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return 0;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const resolved = resolveStoredComposerSession(store, state, sessionKey, agentIdOverride);
    if (resolved.migrated) {
      try {
        writeStore(storage, key, store);
      } catch {
        // The readable draft is still the concurrency baseline for this pane.
      }
    }
    return resolved.session?.draftRevision ?? 0;
  } catch {
    return 0;
  }
}

export function loadChatComposerSnapshot(
  state: Pick<
    ChatComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello"
  >,
  sessionKey: string,
  agentIdOverride?: string,
): { draft: string; queue: ChatQueueItem[] } | null {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    let scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride);
    let resolved = resolveStoredComposerSession(store, state, sessionKey, agentIdOverride);
    if (!resolved.session && scope.isGlobal && scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE) {
      const separator = "\u0000agent:";
      const candidateAgentScopes = new Set<string>();
      for (const [storeSessionKey, value] of Object.entries(store.sessions)) {
        const separatorIndex = storeSessionKey.lastIndexOf(separator);
        if (separatorIndex < 0) {
          continue;
        }
        const rawSessionKey = storeSessionKey.slice(0, separatorIndex);
        const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
        const session = normalizeStoredSession(value);
        const candidateScope = resolveComposerStorageScope(state, rawSessionKey, agentScope);
        if (
          agentScope !== UNRESOLVED_GLOBAL_AGENT_SCOPE &&
          candidateScope.conversationKey === scope.conversationKey &&
          (session?.draft || session?.queue?.length)
        ) {
          candidateAgentScopes.add(agentScope);
        }
      }
      if (candidateAgentScopes.size === 1) {
        const candidateAgentScope = candidateAgentScopes.values().next().value;
        if (typeof candidateAgentScope === "string") {
          scope = resolveComposerStorageScope(state, sessionKey, candidateAgentScope);
          resolved = resolveStoredComposerSession(store, state, sessionKey, candidateAgentScope);
        }
      }
    }
    if (resolved.migrated) {
      try {
        writeStore(storage, key, store);
      } catch {
        // Migration persistence is best-effort; readable drafts and outboxes remain usable.
      }
    }
    const session = resolved.session;
    if (!session || (!session.draft && !session.queue?.length)) {
      return null;
    }
    return {
      draft: session.draft ?? "",
      queue: (session.queue ?? [])
        .map((item) => serializeQueueItemForScope(item, scope))
        .filter((item): item is ChatQueueItem => item !== null)
        .map((item) => ({ ...item, sessionKey })),
    };
  } catch {
    return null;
  }
}

function persistChatComposerStateResult(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return "storage-failed";
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      options.agentId,
    );
    const draft = Object.hasOwn(options, "draft") ? (options.draft ?? "") : state.chatMessage;
    const currentDraftRevision = session?.draftRevision ?? 0;
    if (
      options.expectedDraftRevision !== undefined &&
      currentDraftRevision !== options.expectedDraftRevision
    ) {
      return "conflict";
    }
    const draftRevision = options.draftRevision ?? nextDraftRevision(currentDraftRevision);
    if (!Number.isSafeInteger(draftRevision) || draftRevision <= 0) {
      return "conflict";
    }
    // The same revision may be retried after a quota/storage failure, but an
    // older delayed pane must never replace a newer edit or clear tombstone.
    if (
      currentDraftRevision > draftRevision ||
      (currentDraftRevision === draftRevision && (session?.draft ?? "") !== draft)
    ) {
      return "conflict";
    }
    store.sessions[storeSessionKey] = {
      ...(draft ? { draft } : {}),
      draftRevision,
      ...(session?.queue?.length ? { queue: session.queue } : {}),
      updatedAt: Date.now(),
    };
    writeStore(storage, key, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, key),
      state,
      sessionKey,
      options.agentId,
    ).session;
    if (persisted?.draftRevision === draftRevision && (persisted.draft ?? "") === draft) {
      return "persisted";
    }
    // Retention limits can make a successful storage write omit this draft.
    // Only a same/newer revision is a concurrency conflict; a missing or older
    // row remains retryable as a storage-capacity failure.
    return (persisted?.draftRevision ?? 0) >= draftRevision ? "conflict" : "storage-failed";
  } catch {
    // Best-effort only: quota and privacy-mode storage errors should not break chat.
    return "storage-failed";
  }
}

export function persistChatComposerState(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): boolean {
  return persistChatComposerStateResult(state, sessionKey, options) === "persisted";
}

export function admitStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return false;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const scope = resolveComposerStorageScope(state, sessionKey, agentId ?? item.agentId);
    const serialized = serializeQueueItemForScope(item, scope);
    if (!serialized) {
      return false;
    }
    const { session, storeSessionKey, migrated } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const existing = queue.find((entry) => entry.id === serialized.id);
    if (existing) {
      if (!queueItemsEqual(existing, serialized, scope)) {
        return false;
      }
      if (migrated) {
        writeStore(storage, key, store);
      }
      return true;
    }
    if (queue.length >= MAX_STORED_QUEUE_ITEMS) {
      return false;
    }
    writeStoredComposerSession(store, storeSessionKey, session, [...queue, serialized]);
    writeStore(storage, key, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, key),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.find((entry) => entry.id === serialized.id);
    return Boolean(persisted && queueItemsEqual(persisted, serialized, scope));
  } catch {
    return false;
  }
}

export function updateStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  expected: ChatQueueItem,
  next: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || expected.id !== next.id) {
    return false;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const scope = resolveComposerStorageScope(
      state,
      sessionKey,
      agentId ?? expected.agentId ?? next.agentId,
    );
    const serializedNext = serializeQueueItemForScope(next, scope);
    if (!serializedNext) {
      return false;
    }
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const index = queue.findIndex((entry) => entry.id === expected.id);
    const stored = queue[index];
    if (!stored || !queueItemVersionMatches(stored, expected, scope)) {
      return false;
    }
    const nextQueue = queue.slice();
    nextQueue[index] = serializedNext;
    writeStoredComposerSession(store, storeSessionKey, session, nextQueue);
    writeStore(storage, key, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, key),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.find((entry) => entry.id === serializedNext.id);
    return Boolean(persisted && queueItemsEqual(persisted, serializedNext, scope));
  } catch {
    return false;
  }
}

export function removeStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  id: string,
  expected?: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || !id.trim()) {
    return false;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const scope = resolveComposerStorageScope(state, sessionKey, agentId ?? expected?.agentId);
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) {
      return true;
    }
    const stored = queue[index];
    if (!stored || (expected && !queueItemVersionMatches(stored, expected, scope))) {
      return false;
    }
    writeStoredComposerSession(
      store,
      storeSessionKey,
      session,
      queue.filter((_, queueIndex) => queueIndex !== index),
    );
    writeStore(storage, key, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, key),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.some((item) => item.id === id);
    return !persisted;
  } catch {
    return false;
  }
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const separator = "\u0000agent:";
    let migrated = false;
    const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
    if (selectedGlobalAgentId) {
      const selectedGlobal = resolveStoredComposerSession(
        store,
        state,
        "global",
        selectedGlobalAgentId,
      );
      migrated = selectedGlobal.migrated;
    }
    for (const storeSessionKey of Object.keys(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        continue;
      }
      const sessionKey = storeSessionKey.slice(0, separatorIndex);
      const storedAgentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const resolved = resolveStoredComposerSession(
        store,
        state,
        sessionKey,
        storedAgentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : storedAgentScope,
      );
      migrated = resolved.migrated || migrated;
    }
    if (migrated) {
      try {
        writeStore(storage, key, store);
      } catch {
        // A full storage bucket must not make already-readable outboxes disappear.
      }
    }
    const outboxes: StoredChatOutbox[] = [];
    for (const [storeSessionKey, value] of Object.entries(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        continue;
      }
      const sessionKey = storeSessionKey.slice(0, separatorIndex);
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const session = normalizeStoredSession(value);
      if (!session?.queue?.length) {
        continue;
      }
      const scope = resolveComposerStorageScope(
        state,
        sessionKey,
        agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : agentScope,
      );
      const queue = session.queue
        .map((item) => serializeQueueItemForScope(item, scope))
        .filter((item): item is ChatQueueItem => item !== null);
      if (!queue.length) {
        continue;
      }
      outboxes.push({
        sessionKey: scope.conversationKey,
        ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
        queue,
      });
    }
    return outboxes.toSorted((left, right) => {
      const createdAtDelta =
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
        (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER);
      return createdAtDelta || left.sessionKey.localeCompare(right.sessionKey);
    });
  } catch {
    return [];
  }
}

export function restoreChatComposerState(
  state: ChatComposerPersistenceState,
  options: RestoreOptions = {},
): boolean {
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerSnapshot(state, sessionKey);
  if (!snapshot) {
    return false;
  }
  if (!options.preserveCurrent || !state.chatMessage) {
    state.chatMessage = snapshot.draft;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    state.chatQueue = snapshot.queue;
  }
  return true;
}

type ChatComposerDraftSnapshot = {
  sessionKey: string;
  chatMessage: string;
  agentId?: string;
  expectedDraftRevision: number;
  draftRevision: number;
};

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private currentDraftRevision = 0;

  constructor(private readonly getState: () => ChatComposerPersistenceState | undefined) {}

  start() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.ready = true;
    this.pending = null;
    const draftRevision = this.readStoredDraftRevision(state);
    this.currentDraftRevision = draftRevision;
    this.lastPersisted = this.snapshot(state, draftRevision);
  }

  stop() {
    this.persistNow();
    this.ready = false;
    this.pending = null;
    this.clearTimer();
  }

  restore(options: RestoreOptions = {}): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }
    const restored = restoreChatComposerState(state, options);
    this.pending = null;
    this.clearTimer();
    const draftRevision = this.readStoredDraftRevision(state);
    this.currentDraftRevision = draftRevision;
    this.lastPersisted = this.snapshot(state, draftRevision);
    return restored;
  }

  schedule() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const current = this.snapshot(state);
    if (this.isUnchanged(current)) {
      this.pending = null;
      this.clearTimer();
      return;
    }
    const baseline = Math.max(this.currentDraftRevision, this.pending?.draftRevision ?? 0);
    this.pending = this.snapshot(state, nextDraftRevision(baseline), this.currentDraftRevision);
    this.clearTimer();
    this.timer = globalThis.setTimeout(
      () => this.persistNow(),
      CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
    );
  }

  persistNow() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    let snapshot = this.pending;
    if (!snapshot) {
      const current = this.snapshot(state);
      if (this.isUnchanged(current)) {
        return;
      }
      snapshot = this.snapshot(
        state,
        nextDraftRevision(this.currentDraftRevision),
        this.currentDraftRevision,
      );
    }
    this.clearTimer();
    this.pending = this.persistSnapshot(state, snapshot).status === "persisted" ? null : snapshot;
  }

  persistChangedState() {
    this.persistNow();
  }

  scopeForRouteSwitch(): StoredChatOutboxScope | null {
    const state = this.getState();
    if (!state) {
      return null;
    }
    const current = this.snapshot(state);
    const snapshot =
      this.pending ?? (this.isUnchanged(current) ? (this.lastPersisted ?? current) : current);
    return resolveStoredChatOutboxScope(state, snapshot.sessionKey, snapshot.agentId);
  }

  persistForRouteSwitch(): boolean {
    return this.persistForRouteSwitchResult().status === "persisted";
  }

  persistForRouteSwitchResult(): ChatComposerPersistResult {
    const state = this.getState();
    if (!state) {
      return { status: "persisted" };
    }
    let snapshot = this.pending;
    const current = this.snapshot(state);
    if (
      !snapshot &&
      ((this.ready && this.isUnchanged(current)) || (!this.ready && !current.chatMessage))
    ) {
      this.pending = null;
      this.clearTimer();
      return { status: "persisted" };
    }
    snapshot ??= this.snapshot(
      state,
      nextDraftRevision(this.currentDraftRevision),
      this.currentDraftRevision,
    );
    this.clearTimer();
    const result = this.persistSnapshot(state, snapshot);
    this.pending = result.status === "persisted" ? null : snapshot;
    return result;
  }

  adoptCurrentRoute() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.pending = null;
    this.clearTimer();
    const draftRevision = this.readStoredDraftRevision(state);
    this.currentDraftRevision = draftRevision;
    this.lastPersisted = this.snapshot(state, draftRevision);
  }

  private persistSnapshot(
    state: ChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
  ): ChatComposerPersistResult {
    const status = persistChatComposerStateResult(state, snapshot.sessionKey, {
      agentId: snapshot.agentId,
      draft: snapshot.chatMessage,
      draftRevision: snapshot.draftRevision,
    });
    if (status === "persisted") {
      this.currentDraftRevision = snapshot.draftRevision;
      this.lastPersisted = snapshot;
      return { status };
    }
    if (status === "storage-failed") {
      return {
        status,
        expectedDraftRevision: snapshot.expectedDraftRevision,
        draftRevision: snapshot.draftRevision,
      };
    }
    return { status };
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private isUnchanged(snapshot: ChatComposerDraftSnapshot): boolean {
    const last = this.lastPersisted;
    return Boolean(
      last && last.sessionKey === snapshot.sessionKey && last.chatMessage === snapshot.chatMessage,
    );
  }

  private snapshot(
    state: ChatComposerPersistenceState,
    draftRevision: number = this.currentDraftRevision,
    expectedDraftRevision: number = draftRevision,
  ): ChatComposerDraftSnapshot {
    const scope = resolveStoredChatOutboxScope(state, state.sessionKey);
    return {
      sessionKey: state.sessionKey,
      chatMessage: state.chatMessage,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      expectedDraftRevision,
      draftRevision,
    };
  }

  private readStoredDraftRevision(
    state: ChatComposerPersistenceState,
    sessionKey: string = state.sessionKey,
    agentId?: string,
  ): number {
    // Cold-offline restore may display the sole known agent's draft while the
    // current route is still unresolved. CAS must target the unresolved row so
    // an offline edit can be admitted and migrated once defaults arrive.
    return loadChatComposerDraftRevision(state, sessionKey, agentId);
  }
}

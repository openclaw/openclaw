// Doctor-only reader and writer for retired sessions.json stores.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  migrateLegacySessionEntryState,
  normalizePersistedSessionEntryShape,
} from "../commands/doctor/shared/session-entry-shape.js";
import { normalizeRestartRecoveryEntryFields } from "../config/sessions/restart-recovery-state.js";
import { hasLegacySessionProviderState } from "../config/sessions/session-entry-state-format.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  hydrateSessionStoreSkillPromptRefs,
  projectSessionStoreForPersistence,
} from "../config/sessions/skill-prompt-blobs.js";
import { stripRuntimeOnlySessionSkillsFields } from "../config/sessions/store-entry-shape.js";
import { applyFileBackedSessionStoreMaintenance } from "../config/sessions/store-maintenance-operations.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { assertSupportedSessionStoreEntry } from "../config/sessions/supported-session-store.js";
import {
  normalizeSessionRuntimeModelFields,
  type SessionEntry,
  type SessionOrigin,
} from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import { isPluginJsonValue, type PluginJsonValue } from "../plugins/host-hook-json.js";
import { normalizeSessionEntrySlotKey } from "../plugins/session-entry-slot-keys.js";
import {
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../sessions/agent-harness-session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { migrateLegacySessionCreator } from "../state/creator-namespace-migration.js";
import {
  deliveryContextFromChannelRoute,
  isCanonicalSessionDeliveryState,
  mergeDeliveryContext,
  normalizeDeliveryChannelRoute,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import { writeTextAtomic } from "./json-files.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";

type LegacySessionStoreSaveOptions = {
  skipMaintenance?: boolean;
};

const log = createSubsystemLogger("sessions/legacy-importer");
const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../gateway/session-archive.runtime.js"),
);

function normalizeOptionalDeliveryContext(value: unknown): DeliveryContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext({
    channel: typeof value.channel === "string" ? value.channel : undefined,
    to: typeof value.to === "string" ? value.to : undefined,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    threadId:
      typeof value.threadId === "string" || typeof value.threadId === "number"
        ? value.threadId
        : undefined,
  });
  return normalized?.channel && normalized.to ? normalized : undefined;
}

function sameDeliveryContext(
  left: DeliveryContext | undefined,
  right: DeliveryContext | undefined,
): boolean {
  return (
    (left?.channel ?? undefined) === (right?.channel ?? undefined) &&
    (left?.to ?? undefined) === (right?.to ?? undefined) &&
    (left?.accountId ?? undefined) === (right?.accountId ?? undefined) &&
    (left?.threadId ?? undefined) === (right?.threadId ?? undefined)
  );
}

function normalizeRestartRecoveryFields(entry: SessionEntry): SessionEntry {
  let next = entry;
  const assign = <K extends keyof SessionEntry>(key: K, value: SessionEntry[K] | undefined) => {
    if (entry[key] === value) {
      return;
    }
    if (next === entry) {
      next = { ...entry };
    }
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  };

  const restartContext = normalizeOptionalDeliveryContext(entry.restartRecoveryDeliveryContext);
  if (!sameDeliveryContext(entry.restartRecoveryDeliveryContext, restartContext)) {
    assign("restartRecoveryDeliveryContext", restartContext);
  }
  normalizeRestartRecoveryEntryFields(entry, assign);
  return next;
}

function normalizeLegacyPluginState(
  entry: SessionEntry,
  key: "pluginExtensions" | "pluginExtensionSlotKeys",
  normalizeValue: (value: unknown) => PluginJsonValue | undefined,
): SessionEntry {
  const state = entry[key];
  if (state === undefined) {
    return entry;
  }
  if (!isRecord(state)) {
    const next = { ...entry };
    delete next[key];
    return next;
  }
  let changed = false;
  const normalizedState: Record<string, Record<string, PluginJsonValue>> = {};
  for (const [rawPluginId, rawPluginState] of Object.entries(state)) {
    const pluginId = normalizeOptionalString(rawPluginId);
    if (!pluginId || !isRecord(rawPluginState)) {
      changed = true;
      continue;
    }
    changed ||= pluginId !== rawPluginId;
    const normalizedPluginState: Record<string, PluginJsonValue> = {};
    for (const [rawNamespace, rawValue] of Object.entries(rawPluginState)) {
      const namespace = normalizeOptionalString(rawNamespace);
      const value = normalizeValue(rawValue);
      if (!namespace || value === undefined) {
        changed = true;
        continue;
      }
      changed ||= namespace !== rawNamespace || value !== rawValue;
      normalizedPluginState[namespace] = value;
    }
    if (Object.keys(normalizedPluginState).length === 0) {
      changed = true;
      continue;
    }
    normalizedState[pluginId] = normalizedPluginState;
  }
  if (!changed) {
    return entry;
  }
  const next = { ...entry };
  if (Object.keys(normalizedState).length > 0) {
    Object.assign(next, { [key]: normalizedState });
  } else {
    delete next[key];
  }
  return next;
}

function normalizeLegacySessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    assertSupportedSessionStoreEntry(entry);
    const modelSelectionLocked = isRecord(entry) && entry.modelSelectionLocked === true;
    const shaped = normalizePersistedSessionEntryShape(entry, { sessionKey: key });
    if (!shaped) {
      if (modelSelectionLocked) {
        throw new Error(`Invalid model-selection-locked session entry: ${key}`);
      }
      delete store[key];
      continue;
    }
    const runtimeFields = normalizeSessionRuntimeModelFields(shaped);
    if (modelSelectionLocked && runtimeFields !== shaped) {
      throw new Error(`Invalid model-selection-locked session entry: ${key}`);
    }
    let normalized = normalizeRestartRecoveryFields(
      normalizeLegacySessionEntryDelivery(
        migrateLegacySessionCreator(modelSelectionLocked ? shaped : runtimeFields),
      ),
    );
    normalized = normalizeLegacyPluginState(normalized, "pluginExtensions", (value) =>
      isPluginJsonValue(value) ? value : undefined,
    );
    normalized = normalizeLegacyPluginState(normalized, "pluginExtensionSlotKeys", (value) => {
      const slotKey = normalizeSessionEntrySlotKey(value);
      return slotKey.ok ? slotKey.key : undefined;
    });
    store[key] = stripRuntimeOnlySessionSkillsFields(normalized);
  }
  const harnessError = resolveAgentHarnessSessionStoreError(store);
  if (harnessError) {
    throw new Error(harnessError);
  }
}

export function loadLegacySessionStore(storePath: string): Record<string, SessionEntry> {
  const { store } = readSessionStoreJson5(storePath);
  hydrateSessionStoreSkillPromptRefs({ storePath, store });
  const sessionStore = store as Record<string, SessionEntry>;
  normalizeLegacySessionStore(sessionStore);
  return sessionStore;
}

function snapshotLockedEntries(
  store: Record<string, SessionEntry>,
): ReadonlyMap<string, SessionEntry> {
  return new Map(
    Object.entries(store).flatMap(([sessionKey, entry]) =>
      isValidAgentHarnessSessionStoreEntry(sessionKey, entry)
        ? [[sessionKey, structuredClone(entry)] as const]
        : [],
    ),
  );
}

function assertLegacySessionStoreWriteIsValid(params: {
  lockedEntriesBefore: ReadonlyMap<string, SessionEntry>;
  store: Record<string, SessionEntry>;
}): void {
  const transitionError = resolveAgentHarnessSessionStoreTransitionError({
    before: params.lockedEntriesBefore,
    store: params.store,
  });
  if (transitionError) {
    throw new Error(transitionError);
  }
  const storeError = resolveAgentHarnessSessionStoreError(params.store);
  if (storeError) {
    throw new Error(storeError);
  }
}

async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted";
  restrictToStoreDir: true;
}): Promise<Set<string>> {
  const { archiveSessionTranscriptsDetailed } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscriptsDetailed({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const { archivedPath } of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function persistLegacySessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const persisted = projectSessionStoreForPersistence({
    storePath,
    store,
  });
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await writeTextAtomic(storePath, JSON.stringify(persisted.store, null, 2), {
    beforeRename: async () => {
      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: persisted.promptBlobs.values(),
      });
    },
    durable: true,
    mode: 0o600,
    tempPrefix: path.basename(storePath),
    trailingNewline: true,
  });
}

async function writeLegacySessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  lockedEntriesBefore: ReadonlyMap<string, SessionEntry>,
  options: LegacySessionStoreSaveOptions,
): Promise<void> {
  normalizeLegacySessionStore(store);
  assertLegacySessionStoreWriteIsValid({ lockedEntriesBefore, store });
  if (!options.skipMaintenance) {
    await applyFileBackedSessionStoreMaintenance({
      storePath,
      store,
      log,
      commitReducedStore: () => persistLegacySessionStore(storePath, store),
      artifacts: {
        archiveRemovedSessionTranscripts,
        cleanupArchivedSessionTranscripts: async (params) => {
          const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
          await cleanupArchivedSessionTranscripts(params);
        },
      },
    });
  }
  assertLegacySessionStoreWriteIsValid({ lockedEntriesBefore, store });
  await persistLegacySessionStore(storePath, store);
}

export async function saveLegacySessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  options: LegacySessionStoreSaveOptions = {},
): Promise<void> {
  await runExclusiveSessionStoreWrite(storePath, async () => {
    const currentStore = loadLegacySessionStore(storePath);
    await writeLegacySessionStoreUnlocked(
      storePath,
      store,
      snapshotLockedEntries(currentStore),
      options,
    );
  });
}

export async function updateLegacySessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  options: LegacySessionStoreSaveOptions = {},
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadLegacySessionStore(storePath);
    const lockedEntriesBefore = snapshotLockedEntries(store);
    const result = await mutator(store);
    await writeLegacySessionStoreUnlocked(storePath, store, lockedEntriesBefore, options);
    return result;
  });
}

type LegacySessionDeliveryEntry = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

const LEGACY_SESSION_DELIVERY_KEYS = [
  "route",
  "deliveryContext",
  "origin",
  "channel",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
] as const;

function isInternalContext(context?: DeliveryContext): boolean {
  return Boolean(
    context?.channel &&
    (context.channel === INTERNAL_MESSAGE_CHANNEL || isInternalNonDeliveryChannel(context.channel)),
  );
}

function hasExternalTarget(context?: DeliveryContext): boolean {
  return Boolean(
    context?.channel &&
    context.channel !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(context.channel) &&
    context.to,
  );
}

function mergeExternalOverInternal(
  external?: DeliveryContext,
  internal?: DeliveryContext,
): DeliveryContext | undefined {
  return normalizeDeliveryContext({
    channel: external?.channel,
    to: external?.to,
    accountId: external?.accountId ?? internal?.accountId,
    threadId: external?.threadId ?? internal?.threadId,
  });
}

/** Canonicalizes file-era delivery fields before doctor imports a row into SQLite. */
export function normalizeLegacySessionEntryDelivery(entry: SessionEntry): SessionEntry;
export function normalizeLegacySessionEntryDelivery(
  entry: Record<string, unknown>,
): Record<string, unknown>;
export function normalizeLegacySessionEntryDelivery(value: SessionEntry | Record<string, unknown>) {
  assertSupportedSessionStoreEntry(value);
  const entry =
    isRecord(value) && hasLegacySessionProviderState(value)
      ? migrateLegacySessionEntryState(value)
      : value;
  const legacy = entry as LegacySessionDeliveryEntry;
  const hasLegacyFields = LEGACY_SESSION_DELIVERY_KEYS.some((key) => key in legacy);
  if (isCanonicalSessionDeliveryState(entry.delivery) && !hasLegacyFields) {
    return entry;
  }

  const route = normalizeDeliveryChannelRoute(legacy.route);
  const routeContext = deliveryContextFromChannelRoute(route);
  const explicitContext = normalizeDeliveryContext(legacy.deliveryContext);
  const lastChannel = normalizeDeliveryContext({ channel: legacy.lastChannel })?.channel;
  const storedChannel = normalizeDeliveryContext({ channel: legacy.channel })?.channel;
  const originChannel = normalizeDeliveryContext({ channel: legacy.origin?.provider })?.channel;
  const normalizedLastFields = normalizeDeliveryContext({
    to: legacy.lastTo,
    accountId: legacy.lastAccountId,
    threadId: legacy.lastThreadId,
  });
  const hasNormalizedLastFields = Boolean(
    normalizedLastFields?.to ||
    normalizedLastFields?.accountId ||
    normalizedLastFields?.threadId != null,
  );
  const lastCandidate = normalizeDeliveryContext({
    channel:
      lastChannel ?? (hasNormalizedLastFields ? (storedChannel ?? originChannel) : undefined),
    to: normalizedLastFields?.to,
    accountId: normalizedLastFields?.accountId,
    threadId: normalizedLastFields?.threadId,
  });
  const lastContext =
    isInternalContext(lastCandidate) ||
    hasExternalTarget(lastCandidate) ||
    (lastChannel != null && lastCandidate?.channel != null) ||
    (lastCandidate?.channel && lastCandidate.channel === explicitContext?.channel)
      ? lastCandidate
      : undefined;
  const channelContext = normalizeDeliveryContext({ channel: legacy.channel });
  const originContext = normalizeDeliveryContext({
    channel: legacy.origin?.provider,
    to: legacy.origin?.to,
    accountId: legacy.origin?.accountId,
    threadId: legacy.origin?.threadId,
  });
  const fallbackContext = mergeDeliveryContext(
    lastContext,
    mergeDeliveryContext(explicitContext, mergeDeliveryContext(channelContext, originContext)),
  );
  const internalFallbackContext = isInternalContext(routeContext)
    ? mergeDeliveryContext(routeContext, lastContext)
    : isInternalContext(lastContext)
      ? lastContext
      : isInternalContext(channelContext)
        ? mergeDeliveryContext(channelContext, lastContext)
        : undefined;
  const hasInternalFallback =
    internalFallbackContext !== undefined && hasExternalTarget(explicitContext);
  const context = hasInternalFallback
    ? mergeExternalOverInternal(explicitContext, internalFallbackContext)
    : mergeDeliveryContext(routeContext, fallbackContext);
  const migratedDelivery = normalizeSessionDeliveryState({
    route: hasInternalFallback ? undefined : route,
    context,
    origin: legacy.origin,
  });
  const recoverLegacyDelivery =
    isCanonicalSessionDeliveryState(entry.delivery) &&
    ((entry.delivery.kind === "none" && migratedDelivery.kind !== "none") ||
      (entry.delivery.kind === "internal" && migratedDelivery.kind === "external"));
  const delivery =
    isCanonicalSessionDeliveryState(entry.delivery) && !recoverLegacyDelivery
      ? entry.delivery
      : migratedDelivery;
  const next = { ...entry, delivery } as LegacySessionDeliveryEntry;
  const legacyChatType = legacy.origin?.chatType;
  if (
    next.chatType == null &&
    (legacyChatType === "direct" || legacyChatType === "group" || legacyChatType === "channel")
  ) {
    next.chatType = legacyChatType;
  }
  for (const key of LEGACY_SESSION_DELIVERY_KEYS) {
    delete next[key];
  }
  return next;
}

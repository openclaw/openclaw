import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSessionStoreIdentity } from "../../gateway/session-store-key.js";
import {
  isIncognitoSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { collectCanonicalSessionLookupKeys } from "./main-session-key.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  readResolvedSessionStoreTargetsInWorker,
  selectCanonicalSessionEntryMatch,
} from "./session-accessor.entry-read-runtime.js";
import {
  assertMemoryExactReadSource,
  captureMemoryExactSessionReader,
} from "./session-accessor.memory-exact-read.js";
import "./plugin-host-cleanup.js";
import "./session-accessor.sqlite-canonical-repair.js";
import {
  listSessionEntryRows,
  listSessionEntriesReadOnly,
  loadExactSessionEntry,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
  patchSessionEntryTarget,
} from "./session-accessor.sqlite-entry.js";
import { resolveSessionEntry as resolveSessionEntrySelection } from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import "./session-accessor.sqlite-summary.js";
import type {
  SessionAccessScope,
  LogicalSessionAccessScope,
  SessionEntryListScope,
  ResolvedSessionEntryAccessTarget,
  ResolvedSessionEntryStoreTarget,
  QualifiedSessionEntryAccessTarget,
  SessionEntryCandidateAccessScope,
  ResolvedSessionEntryCandidateTarget,
  ResolvedSessionEntryUpdateContext,
  ResolvedSessionEntryUpdateResult,
  SessionEntrySummary,
  SessionEntryReadView,
  SessionEntryPatchOptions,
  SessionEntryPatchContext,
  SessionEntryPatchResult,
} from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import {
  normalizeStoreSessionKey,
  resolveSessionStoreEntryCore as resolveSessionEntryFromStore,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export { readResolvedSessionEntryInWorker } from "./session-accessor.entry-read-runtime.js";
export { clearPluginOwnedSessionState } from "./plugin-host-cleanup.js";
export {
  copySqliteSessionOwnedStateForCanonicalRepair as copySessionOwnedStateForCanonicalRepair,
  ensureSqliteTranscriptGenerationsForCanonicalRepair as ensureTranscriptGenerationsForCanonicalRepair,
  listSqliteSessionGenerationIdsForCanonicalRepair as listSessionGenerationIdsForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepair as rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch as rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
} from "./session-accessor.sqlite-canonical-repair.js";
export {
  ensureSessionEntrySync,
  listSessionEntriesReadOnly,
  listSessionEntryKeysReadOnly,
  loadExactSessionEntry,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryFromStoreReadOnly,
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  // Intentionally unfenced: branching owns session-identity freshness; worker transcript commit
  // fresh-reads and checks sessionId inside its locked commit, and void/entry has no rebound signal.
  replaceSessionEntrySync,
  upsertSessionEntryCore,
  withSessionEntryReadOnlyScope,
} from "./session-accessor.sqlite-entry.js";
export { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";

export { resolveSessionEntryFromStore, resolveSessionEntrySelection };

function resolveLogicalSessionStoreCandidates(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[] {
  const storeConfig = params.cfg.session?.store;
  const defaultTarget = {
    agentId: params.agentId,
    storePath: resolveSessionStorePathCore(storeConfig, {
      agentId: params.agentId,
      env: params.env,
    }),
  };
  if (typeof storeConfig !== "string" || !storeConfig.includes("{agentId}")) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    if (target.agentId === params.agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function findCanonicalSessionEntryMatch(
  scope: Omit<SessionAccessScope, "sessionKey">,
  canonicalKey: string,
  candidateKeys: readonly string[],
  options: { readOnly?: boolean } = {},
): (SessionEntrySummary & { readSource?: CapturedSessionEntryReadSource }) | undefined {
  let readSource: CapturedSessionEntryReadSource | undefined;
  const entries = loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: candidateKeys,
    readOnly: options.readOnly !== false,
    onReadSource: (source) => {
      readSource = source;
    },
  });
  const selected = selectCanonicalSessionEntryMatch(entries, canonicalKey);
  return selected ? { ...selected, readSource } : undefined;
}

/** Resolves one canonical row across the prepared configured and discovered store targets. */
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
  options: { keyFormat: "agent-qualified" },
): Promise<QualifiedSessionEntryAccessTarget>;
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryAccessTarget;
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
  options?: { keyFormat?: "agent-qualified" },
): ResolvedSessionEntryAccessTarget | Promise<QualifiedSessionEntryAccessTarget> {
  const target = resolveSessionEntryStoreTarget(scope);
  if (options?.keyFormat === "agent-qualified") {
    return prepareQualifiedSessionEntryTarget(target, undefined, scope.env);
  }
  return {
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    entry: target.entry,
    requestedKey: target.requestedKey,
    storeKey: target.storeKey,
  };
}

/** Resolves ordered candidate keys inside one agent-owned session store. */
export function resolveSessionEntryCandidateTarget(
  scope: SessionEntryCandidateAccessScope,
): ResolvedSessionEntryCandidateTarget | null {
  const candidateKeys = uniqueStrings(scope.candidateKeys.map((key) => key.trim()));
  const incognitoKey = candidateKeys.find(isIncognitoSessionKey);
  const incognitoAgentId = incognitoKey ? resolveAgentIdFromSessionKey(incognitoKey) : undefined;
  const storePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : resolveSessionStorePathCore(scope.cfg.session?.store, {
        agentId: scope.agentId,
        env: scope.env,
      });
  const resolvedAgentId = incognitoAgentId ?? scope.agentId;
  for (const candidateKey of candidateKeys) {
    if (!candidateKey) {
      continue;
    }
    const resolved = resolveSessionEntrySelection(
      {
        agentId: resolvedAgentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionKey: candidateKey,
        storePath,
      },
      { readOnly: !incognitoAgentId },
    );
    if (!resolved.existing) {
      continue;
    }
    return {
      agentId: resolvedAgentId,
      candidateKey,
      entry: resolved.existing,
      persisted: true,
      sessionKey: resolved.normalizedKey,
    };
  }
  const fallbackKey = scope.fallback?.sessionKey.trim();
  if (!fallbackKey || !scope.fallback) {
    return null;
  }
  return {
    agentId: resolvedAgentId,
    candidateKey: fallbackKey,
    entry: structuredClone(scope.fallback.entry),
    persisted: false,
    sessionKey: fallbackKey,
  };
}

/** Resolve ordered candidates through the session owner without synchronous discovery. */
export async function resolveSessionEntryCandidateTargetForRuntime(
  scope: SessionEntryCandidateAccessScope,
): Promise<ResolvedSessionEntryCandidateTarget | null> {
  const candidates = uniqueStrings(scope.candidateKeys.map((key) => key.trim()).filter(Boolean));
  const sessionKey = candidates.find(isIncognitoSessionKey);
  const binding = sessionKey && captureIncognitoSessionBinding({ ...scope, sessionKey });
  const agentId = binding ? binding.actor.agentId : scope.agentId;
  const keys = candidates.map((candidateKey) => ({
    candidateKey,
    sessionKey: resolveSqliteSessionKey(candidateKey, agentId),
  }));
  const fallback = () => {
    const entry = scope.fallback;
    const fallbackKey = entry?.sessionKey.trim();
    return entry && fallbackKey
      ? {
          agentId,
          candidateKey: fallbackKey,
          entry: structuredClone(entry.entry),
          persisted: false,
          sessionKey: fallbackKey,
        }
      : null;
  };
  if (binding) {
    return binding.actor.sessions.withSharedState(async () => {
      for (const key of keys) {
        if (!isIncognitoSessionKey(key.sessionKey)) {
          continue;
        }
        const read = await binding.actor.sessions.read(
          { assertCurrent: () => binding.actor.assertReadable() },
          { sessionKey: key.sessionKey },
          binding.admissionSignal,
        );
        if (read.entry) {
          return { agentId, ...key, entry: read.entry, persisted: true };
        }
      }
      return fallback();
    });
  }
  if (keys.length === 0) {
    return fallback();
  }
  const read = await readSessionEntriesFromStoreInWorker({
    agentId,
    env: scope.env,
    storePath: resolveSessionStorePathCore(scope.cfg.session?.store, {
      agentId,
      env: scope.env,
    }),
    sessionKeys: keys.map((key) => key.sessionKey),
    projection: "exact",
  });
  for (const key of keys) {
    const entry = read.entries.find((row) => row.sessionKey === key.sessionKey)?.entry;
    if (entry) {
      return { agentId, ...key, entry, persisted: true };
    }
  }
  return fallback();
}

function resolveSessionEntryStoreTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryStoreTarget & { readSource?: CapturedSessionEntryReadSource } {
  const requestedKey = scope.sessionKey.trim();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg: scope.cfg,
    sessionKey: requestedKey,
    agentId: scope.agentId,
  });
  const scanTargets = collectCanonicalSessionLookupKeys({
    agentId,
    canonicalKey,
    mainKey: scope.cfg.session?.mainKey,
    requestedKey,
  });
  const incognito = isIncognitoSessionKey(canonicalKey);
  const targetAgentId = incognito ? resolveAgentIdFromSessionKey(canonicalKey) : agentId;
  const candidates = incognito
    ? [
        {
          agentId: targetAgentId,
          storePath: resolveIncognitoOpenClawAgentSqlitePath({
            agentId: targetAgentId,
            env: scope.env,
          }),
        },
      ]
    : resolveLogicalSessionStoreCandidates({ agentId, cfg: scope.cfg, env: scope.env });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveSessionStorePathCore(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch: ReturnType<typeof findCanonicalSessionEntryMatch>;
  for (const candidate of [fallback, ...candidates.slice(1)]) {
    const match = findCanonicalSessionEntryMatch(
      {
        agentId: targetAgentId,
        ...(scope.env ? { env: scope.env } : {}),
        storePath: candidate.storePath,
      },
      canonicalKey,
      scanTargets,
      { readOnly: !incognito },
    );
    if (match && selectedMatch) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
    }
    if (match) {
      selectedStorePath = candidate.storePath;
      selectedMatch = match;
    }
  }
  return {
    agentId: targetAgentId,
    canonicalKey,
    entry: selectedMatch?.entry,
    requestedKey,
    storeKey: selectedMatch?.sessionKey ?? canonicalKey,
    storePath: selectedStorePath,
    readSource: selectedMatch?.readSource,
  };
}

export async function prepareQualifiedSessionEntryTarget(
  target: ResolvedSessionEntryStoreTarget & { readSource?: CapturedSessionEntryReadSource },
  readSources: readonly CapturedSessionEntryReadSource[] = [],
  env?: NodeJS.ProcessEnv,
) {
  // Projection never reinterprets the original selector or selects a different row.
  if (target.entry && !target.readSource) {
    throw new Error("Qualified session projection requires its captured physical source");
  }
  const canonicalKey = toAgentStoreSessionKey({
    agentId: target.agentId,
    requestKey: target.storeKey,
  });
  const parsed = parseAgentSessionKey(canonicalKey);
  const physicalKeys = (physicalAgentId: string) => {
    if (parsed?.rest !== "global" && parsed?.rest !== "unknown") {
      return [canonicalKey];
    }
    return physicalAgentId === target.agentId ? [parsed.rest, canonicalKey] : [canonicalKey];
  };
  const qualified: QualifiedSessionEntryAccessTarget = {
    keyFormat: "agent-qualified",
    agentId: target.agentId,
    canonicalKey,
    requestedKey: target.requestedKey,
    storeKey: target.storeKey,
    storeKeys: uniqueStrings([
      target.storeKey,
      ...physicalKeys(target.readSource?.agentId ?? target.agentId),
    ]),
    storePath: target.readSource?.path ?? target.storePath,
    entry: target.entry,
    readSource: target.readSource,
  };
  const capturedSources = target.readSource
    ? [
        target.readSource,
        ...readSources.filter((source) => !isDeepStrictEqual(source, target.readSource)),
      ]
    : readSources;
  await Promise.all(
    capturedSources.map(async (readSource) => {
      const selectedSource =
        readSource.agentId === target.readSource?.agentId &&
        readSource.databaseIdentity === target.readSource.databaseIdentity &&
        readSource.databaseBirthtime === target.readSource.databaseBirthtime;
      const sessionKeys = physicalKeys(readSource.agentId).filter(
        (key) => !selectedSource || key !== target.storeKey,
      );
      if (!sessionKeys.length) {
        return;
      }
      const memory = captureMemoryExactSessionReader({
        agentId: readSource.agentId,
        storePath: readSource.path,
      });
      let occupied: boolean;
      if (memory) {
        assertMemoryExactReadSource(readSource, memory.source);
        occupied = sessionKeys.some((key) => memory.read(key, "list"));
      } else {
        const result = await readSessionEntriesFromStoreInWorker({
          agentId: readSource.agentId,
          storePath: readSource.path,
          sessionKeys,
          projection: "sharing",
          includeAuthorization: true,
          env,
        });
        if (
          result.sharing?.source.agentId !== readSource.agentId ||
          result.databaseIdentity?.identity !== readSource.databaseIdentity ||
          result.databaseIdentity?.birthtime !== readSource.databaseBirthtime
        ) {
          throw new Error("Captured session database changed before read");
        }
        occupied = result.entries.length > 0 || result.sharing.placeholders.length > 0;
      }
      if (occupied) {
        throw new Error(
          `Session "${canonicalKey}" has ambiguous stored identity. Select an unambiguous session; stored rows and history were not changed.`,
        );
      }
    }),
  );
  // Later alternate-key or sibling-store duplicates affect discovery, not this pinned target.
  return qualified;
}

/**
 * Mutates the canonical logical session entry without exposing the
 * backing store map to callers.
 */
export async function updateResolvedSessionEntry<T>(
  scope: LogicalSessionAccessScope,
  update: (entry: SessionEntry, context: ResolvedSessionEntryUpdateContext) => Promise<T> | T,
  options?: { target: QualifiedSessionEntryAccessTarget },
): Promise<ResolvedSessionEntryUpdateResult<T>> {
  const captured = options?.target;
  const requestedKey = scope.sessionKey.trim();
  const identity = resolveSessionStoreIdentity({ ...scope, sessionKey: requestedKey });
  const target =
    captured ??
    (isIncognitoSessionKey(identity.canonicalKey)
      ? resolveSessionEntryStoreTarget(scope)
      : scope.cfg.session?.store?.includes("{agentId}")
        ? expectDefined(
            (
              await readResolvedSessionStoreTargetsInWorker({
                ...scope,
                sessionKeys: [scope.sessionKey],
              })
            ).get(scope.sessionKey),
            "session update target",
          )
        : {
            ...identity,
            requestedKey,
            storeKey: identity.canonicalKey,
            storePath: resolveSessionStorePathCore(scope.cfg.session?.store, {
              agentId: identity.agentId,
              env: scope.env,
            }),
          });
  const source = captured?.readSource;
  if (captured && (!captured.entry || !source)) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  if (captured) {
    const current = resolveSessionStoreIdentity({
      cfg: scope.cfg,
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    });
    if (
      scope.sessionKey.trim() !== captured.requestedKey ||
      current.agentId !== captured.agentId ||
      current.canonicalKey !== captured.storeKey
    ) {
      throw new Error("Captured session selector changed before update");
    }
  }
  const expectedSessionId = captured?.entry?.sessionId;
  const expectedLifecycleRevision = captured?.entry?.lifecycleRevision;
  let updateResult: T | undefined;
  const apply = async (entry: SessionEntry) => {
    if (
      captured &&
      (entry.sessionId !== expectedSessionId ||
        entry.lifecycleRevision !== expectedLifecycleRevision)
    ) {
      throw new Error("Captured session generation changed before update");
    }
    const context: ResolvedSessionEntryUpdateContext = {
      agentId: target.agentId,
      canonicalKey: target.canonicalKey,
      entry,
      requestedKey: target.requestedKey,
      storeKey: target.storeKey,
    };
    updateResult = await update(entry, context);
    return entry;
  };
  const patchOptions = { replaceEntry: true, skipMaintenance: true };
  const updated =
    captured && source
      ? await patchSessionEntryTarget(
          {
            agentId: captured.agentId,
            env: scope.env,
            storePath: source.path,
            readSource: source,
            target: { canonicalKey: captured.storeKey, storeKeys: [...captured.storeKeys] },
          },
          apply,
          patchOptions,
        )
      : await patchSessionEntryCore(
          { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath },
          apply,
          patchOptions,
        );
  if (!updated) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  return {
    canonicalKey: target.canonicalKey,
    entry: structuredClone(updated),
    found: true,
    result: updateResult as T,
    storeKey: target.storeKey,
  };
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntriesCore(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  if (scope.clone === false) {
    return openSessionEntryReadView(scope).entries();
  }
  return listSessionEntryRows(scope);
}

/**
 * Synchronous read view: `get` queries one exact persisted key without alias resolution;
 * `entries` caches listing metadata or loads complete entries. Rows and nested values are
 * borrowed: callers must not mutate them and must drop the view before any await.
 */
export function openSessionEntryReadView(
  scope: Omit<SessionEntryListScope, "clone" | "readConsistency"> = {},
): SessionEntryReadView {
  return {
    get: (sessionKey) =>
      (isIncognitoSessionKey(sessionKey) ? loadExactSessionEntry : loadExactSessionEntryReadOnly)({
        ...scope,
        clone: false,
        sessionKey,
      })?.entry,
    entries: () => listSessionEntriesReadOnly({ ...scope, clone: false }),
  };
}

/**
 * Applies an atomic patch and returns the persisted key selected by the backing
 * store. Use when a caller must keep sidecar state keyed to the final row.
 */
export async function patchSessionEntryWithKey(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntryPatchResult | null> {
  const entry = await patchSessionEntryCore(scope, update, options);
  return entry ? { sessionKey: normalizeStoreSessionKey(scope.sessionKey), entry } : null;
}

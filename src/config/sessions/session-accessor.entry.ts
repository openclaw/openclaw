import { isDeepStrictEqual } from "node:util";
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
import { resolveAgentMainSessionKey } from "./main-session.js";
import { resolveSessionStorePathCore } from "./paths.js";
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
import {
  resolveSessionEntry,
  retainSessionEntryKeyAbsence,
} from "./session-accessor.sqlite-exact-read.js";
import "./session-accessor.sqlite-summary.js";
import type {
  SessionAccessScope,
  LogicalSessionAccessScope,
  SessionEntryListScope,
  ResolvedSessionEntryAccessTarget,
  ResolvedSessionEntryStoreTarget,
  QualifiedSessionEntryAccessTarget,
  CapturedSessionEntryReadSource,
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
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  normalizeStoreSessionKey,
  resolveSessionStoreEntryCore as resolveSessionEntryFromStore,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
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
  hasSessionEntriesByStatusReadOnly,
  listSessionChildEntriesReadOnly,
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
export { readSessionStoreSummaryReadOnly } from "./session-accessor.sqlite-summary.js";

export { resolveSessionEntryFromStore };

/** Resolves a session directly through canonical SQLite row and alias ownership. */
export function resolveSessionEntrySelection(
  scope: SessionAccessScope,
  options: Parameters<typeof resolveSessionEntry>[1] = {},
): ReturnType<typeof resolveSessionEntryFromStore> {
  return resolveSessionEntry(scope, options);
}

export function resolveAccessStorePath(scope: SessionAccessScope): string {
  return resolveSessionStorePathForScope(scope);
}

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

function buildLogicalSessionEntryCandidateKeys(params: {
  agentId: string;
  canonicalKey: string;
  cfg: OpenClawConfig;
  requestedKey: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.requestedKey && params.requestedKey !== params.canonicalKey) {
    targets.add(params.requestedKey);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function findCanonicalSessionEntryMatch(
  scope: Omit<SessionAccessScope, "sessionKey">,
  canonicalKey: string,
  candidateKeys: readonly string[],
  options: { readOnly?: boolean } = {},
): (SessionEntrySummary & { readSource?: CapturedSessionEntryReadSource }) | undefined {
  let selected: SessionEntrySummary | undefined;
  let readSource: CapturedSessionEntryReadSource | undefined;
  for (const match of loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: candidateKeys,
    readOnly: options.readOnly !== false,
    onReadSource: (source, physical) => {
      readSource = physical
        ? {
            ...source,
            databaseIdentity: physical.identity,
            databaseBirthtime: physical.birthtime,
          }
        : undefined;
    },
  })) {
    if (selected) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${canonicalKey}`,
      );
    }
    if (match.sessionKey !== canonicalKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    }
    selected = match;
  }
  return selected ? { ...selected, readSource } : undefined;
}

/** Resolves one canonical row across the prepared configured and discovered store targets. */
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
  options: { keyFormat: "agent-qualified" },
): QualifiedSessionEntryAccessTarget;
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryAccessTarget;
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
  options?: { keyFormat: "agent-qualified" },
): ResolvedSessionEntryAccessTarget | QualifiedSessionEntryAccessTarget {
  const target = resolveSessionEntryStoreTarget(scope);
  if (options?.keyFormat === "agent-qualified") {
    return projectQualifiedSessionEntryTarget(scope, target);
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

function resolveSessionEntryStoreTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryStoreTarget & { readSource?: CapturedSessionEntryReadSource } {
  const requestedKey = scope.sessionKey.trim();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg: scope.cfg,
    sessionKey: requestedKey,
    agentId: scope.agentId,
  });
  const scanTargets = buildLogicalSessionEntryCandidateKeys({
    agentId,
    canonicalKey,
    cfg: scope.cfg,
    requestedKey,
  });
  if (isIncognitoSessionKey(canonicalKey)) {
    const incognitoAgentId = resolveAgentIdFromSessionKey(canonicalKey);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: incognitoAgentId,
      env: scope.env,
    });
    const selectedMatch = findCanonicalSessionEntryMatch(
      { agentId: incognitoAgentId, ...(scope.env ? { env: scope.env } : {}), storePath },
      canonicalKey,
      scanTargets,
      { readOnly: false },
    );
    return {
      agentId: incognitoAgentId,
      canonicalKey,
      entry: selectedMatch?.entry,
      requestedKey,
      storeKey: selectedMatch?.sessionKey ?? canonicalKey,
      storePath,
      readSource: selectedMatch?.readSource,
    };
  }
  const candidates = resolveLogicalSessionStoreCandidates({
    agentId,
    cfg: scope.cfg,
    env: scope.env,
  });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveSessionStorePathCore(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findCanonicalSessionEntryMatch(
    { agentId, ...(scope.env ? { env: scope.env } : {}), storePath: fallback.storePath },
    canonicalKey,
    scanTargets,
  );
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findCanonicalSessionEntryMatch(
      { agentId, ...(scope.env ? { env: scope.env } : {}), storePath: candidate.storePath },
      canonicalKey,
      scanTargets,
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
    agentId,
    canonicalKey,
    entry: selectedMatch?.entry,
    requestedKey,
    storeKey: selectedMatch?.sessionKey ?? canonicalKey,
    storePath: selectedStorePath,
    readSource: selectedMatch?.readSource,
  };
}

function projectQualifiedSessionEntryTarget(
  scope: Pick<LogicalSessionAccessScope, "env">,
  target: ResolvedSessionEntryStoreTarget & { readSource?: CapturedSessionEntryReadSource },
): QualifiedSessionEntryAccessTarget {
  const prepared = prepareQualifiedSessionEntryTarget(target, undefined, scope.env);
  try {
    return prepared.target;
  } finally {
    prepared.release();
  }
}

export function prepareQualifiedSessionEntryTarget(
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
  const sources: ReturnType<typeof retainSessionEntryKeyAbsence>[] = [];
  let active = true;
  const release = () => {
    active = false;
    const failures: unknown[] = [];
    for (let index = sources.length - 1; index >= 0; index--) {
      try {
        sources[index]!.release();
        sources.splice(index, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Qualified session sources could not be released");
    }
  };
  try {
    const capturedSources = target.readSource
      ? [
          target.readSource,
          ...readSources.filter((source) => !isDeepStrictEqual(source, target.readSource)),
        ]
      : readSources;
    for (const readSource of capturedSources) {
      const selectedSource =
        readSource.agentId === target.readSource?.agentId &&
        readSource.databaseIdentity === target.readSource.databaseIdentity &&
        readSource.databaseBirthtime === target.readSource.databaseBirthtime;
      sources.push(
        retainSessionEntryKeyAbsence({
          source: readSource,
          canonicalKey,
          sessionKeys: physicalKeys(readSource.agentId).filter(
            (key) => !selectedSource || key !== target.storeKey,
          ),
          env,
        }),
      );
    }
    return {
      target: qualified,
      assertCurrent: () => {
        if (!active) {
          throw new Error("Qualified session target is no longer active");
        }
        for (const source of sources) {
          source.assertCurrent();
        }
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
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
  const target = captured ?? resolveSessionEntryStoreTarget(scope);
  const source = captured?.readSource;
  if (!target.entry || (captured && !source)) {
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
  const expectedSessionId = target.entry.sessionId;
  const expectedLifecycleRevision = target.entry.lifecycleRevision;
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

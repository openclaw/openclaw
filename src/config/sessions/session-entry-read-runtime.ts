import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { resolveSessionLifecycleTimestampsWithHeader } from "./lifecycle-timestamps.js";
import { matchesPluginHostCleanupSession } from "./plugin-host-cleanup.js";
import {
  assertMemoryExactReadSource,
  captureMemoryExactSessionReader,
} from "./session-accessor.memory-exact-read.js";
import { resolveSqliteAgentId, resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryReadScope,
  SessionEntryReadOnlyWorkerScope,
  SessionEntrySummary,
} from "./session-accessor.types.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import {
  readSessionEntriesWithRetainedFacts,
  readSessionEntryWithRetainedFacts,
} from "./session-entry-read-facts.js";
import {
  readAdmittedSessionEntry,
  withOrderedSessionEntriesInWorker,
} from "./session-entry-read-ordered.js";
import {
  captureSessionEntryReadScope,
  captureSessionEntryWorkerRequest,
} from "./session-entry-read-request.js";
import type {
  SessionEntryWorkerRead,
  PreparedSessionEntryWorkerRead,
  SessionStoreWorkerReadInput,
  SessionStoreWorkerReadScope,
  SessionEntryReadSourcePreparation,
  SessionEntryCohortReadOptions,
  SessionEntryCohortReader,
  SessionEntrySummaryWorkerRead,
} from "./session-entry-read-runtime.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryListWorkerResult,
  SessionEntryReadWorkerResult,
  SessionExactEntriesWorkerResult,
} from "./session-entry-read.types.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import {
  prepareSessionStoreReaderCandidates,
  withSessionStoreTarget,
} from "./session-store-target-runtime.js";
import type { SessionStoreWorkerReader } from "./session-store-worker-reader.types.js";
import {
  projectionLane,
  targetDiscoveryLane,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryReadWorkerOwner = {
  kind: "incognito" | "file" | "unresolved";
  assertCurrent: () => void;
  scope?: SessionEntryReadOnlyWorkerScope;
  source?: SessionEntryReadWorkerResult["source"];
  selectedStore?: Readonly<Pick<SessionStoreReadCandidate, "path" | "physicalPath">>;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch?: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget?: () => Promise<void>;
};

/** Retain the original logical source through its asynchronous consumer and owned effects. */
export async function withSessionEntryReadOnlyInWorker<T>(
  input: SessionEntryReadScope,
  assertCallerCurrent: () => void,
  consume: (
    read: Result<SessionEntry | undefined, unknown>,
    owner: SessionEntryReadWorkerOwner,
  ) => Promise<T>,
  prepareSource?: SessionEntryReadSourcePreparation,
  lane?: SessionHistoryWorkerLane,
): Promise<T> {
  const memory = captureMemoryExactSessionReader(input, assertCallerCurrent);
  if (memory) {
    const entry = memory.read(input.sessionKey, input.projection);
    return consume(ok(entry), {
      kind: "incognito",
      assertCurrent: () => memory.assertCurrent(),
      source: memory.source,
    });
  }
  const { scope, agentId } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  const consumeRead = async (
    read: Result<SessionEntry | undefined, unknown>,
    owner: SessionEntryReadWorkerOwner,
  ) => {
    assertCallerCurrent();
    const value = await consume(read, owner);
    assertCallerCurrent();
    return value;
  };
  const onReadError = (error: unknown) =>
    consumeRead(err(error), { kind: "unresolved", assertCurrent: assertCallerCurrent });
  const storePath =
    scope.storePath || (agentId && resolveOpenClawAgentSqlitePath({ agentId, env: scope.env }));
  if (!storePath) {
    return onReadError(new Error("Cannot resolve SQLite session scope without an agent id"));
  }
  return withSessionStoreReaderInWorker(
    { ...scope, agentId, storePath },
    async ({ reader, database, continuation, logicalAgentId, ...owner }) => {
      // Keep live caller signals and callbacks out of request sizing and worker transport.
      const readScope = {
        agentId: logicalAgentId,
        databaseAgentId: database.agentId,
        storePath: database.path,
        env: database.env,
        sessionKey: scope.sessionKey,
        clone: scope.clone,
        defaultAgentId: scope.defaultAgentId,
        hydrateSkillPromptRefs: scope.hydrateSkillPromptRefs,
        readConsistency: scope.readConsistency,
        projection: scope.projection,
      };
      const read = await readSessionEntryWithRetainedFacts(database, readScope, () =>
        reader.readEntryResult({ scope: readScope, continuation }),
      );
      owner.assertCurrent();
      const value = await consumeRead(read, {
        ...owner,
        kind: "file",
        scope: readScope,
        source: read.source,
      });
      owner.assertCurrent();
      return value;
    },
    {
      backing: true,
      lane: lane ?? projectionLane,
      dataOnly: true,
      logical: { assertCurrent: assertCallerCurrent, onReadError },
      prepareSource,
    },
  );
}

/** Return entry data only after the retained physical reader has finished its currentness checks. */
export function readSessionEntryReadOnlyInWorker(
  input: SessionEntryReadScope,
  assertCallerCurrent: () => void = () => {},
  reader?: SessionEntryCohortReader,
  lane?: SessionHistoryWorkerLane,
): Promise<SessionEntry | undefined> {
  if (reader) {
    return readAdmittedSessionEntry(reader, input, assertCallerCurrent);
  }
  return withSessionEntryReadOnlyInWorker(
    input,
    assertCallerCurrent,
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return read.value;
    },
    undefined,
    lane,
  );
}

/** Resolve a current transcript identity in the selected store without loading its siblings. */
export async function readSessionEntryByIdReadOnlyInWorker(
  input: Omit<SessionEntryReadScope, "sessionKey"> & {
    sessionId: string;
    orderBy?: "updatedAt";
  },
): Promise<SessionEntrySummary | undefined> {
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    return memory.readById(input.sessionId, input.projection, input.orderBy);
  }
  const { scope, agentId } = captureSessionEntryReadScope({ ...input, sessionKey: "" });
  const storePath =
    scope.storePath || (agentId && resolveOpenClawAgentSqlitePath({ agentId, env: scope.env }));
  if (!storePath) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return withSessionStoreReaderInWorker(
    { ...scope, agentId, storePath },
    async ({ reader, database, continuation, assertCurrent }) => {
      const read = await reader.readExactEntries({
        selection: { kind: "session-id", sessionId: input.sessionId, orderBy: input.orderBy },
        projection: "full",
        env: database.env,
        continuation,
      });
      assertCurrent();
      return read.entries[0];
    },
    { backing: true, dataOnly: true },
  );
}

/** Envelope timestamps are descriptive reads; missing stores remain absent. */
export async function readSessionUpdatedAtInWorker(input: SessionAccessScope) {
  const entry = await readSessionEntryReadOnlyInWorker({ ...input, projection: "list" });
  return entry?.updatedAt;
}

export { readSessionEntryInWorker } from "./session-entry-read-writable.js";

/** Retain one metadata inventory; the worker checks its native revision before reusing it. */
export function createSessionEntryListReader(
  input: Pick<SessionStoreWorkerReadScope, "agentId" | "storePath" | "env">,
) {
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    return async () => ({
      entries: memory.entries("list"),
      assertCurrent: () => memory.assertCurrent(),
    });
  }
  const scope = { ...input, env: cloneEnvWithPlatformSemantics(input.env ?? process.env) };
  let snapshot: SessionEntryListWorkerResult = { kind: "session-entry-list", entries: [] };
  let pending:
    | Promise<{
        entries: SessionEntryListWorkerResult["entries"];
        assertCurrent: () => void;
      }>
    | undefined;
  return () =>
    (pending ??= withSessionStoreReaderInWorker(
      scope,
      async ({ reader, database, continuation, assertCurrent }) => {
        const result = await reader.readEntries(
          {
            agentId: database.agentId,
            storePath: database.path,
            env: database.env,
            projection: "list",
            includeParticipants: false,
            hydrateSkillPromptRefs: false,
          },
          continuation,
          undefined,
          snapshot.revision,
        );
        assertCurrent();
        if (!result.unchanged) {
          snapshot = result;
        }
        const source = result.source;
        return {
          entries: snapshot.entries,
          // The worker lifetime ends on return. Retain only the physical source fence.
          assertCurrent: () => {
            if (source) {
              assertCapturedSessionEntryReadSource(source);
            }
          },
        };
      },
      { backing: true, dataOnly: true, capturePhysicalSource: true, lane: projectionLane },
    ).finally(() => {
      pending = undefined;
    }));
}

/** Read descriptive summaries through the original store selection and reader lifetime. */
export async function readSessionEntrySummariesInWorker(input: SessionEntrySummaryWorkerRead) {
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    return memory
      .entries("list")
      .filter(({ sessionKey, entry }) =>
        matchesPluginHostCleanupSession(sessionKey, entry, input.cleanupSession),
      );
  }
  const { scope } = captureSessionEntryReadScope({ ...input, sessionKey: "" });
  return withSessionStoreReaderInWorker(
    { ...input, env: scope.env, storePath: scope.storePath ?? input.storePath },
    async ({ reader, database, continuation, assertCurrent }) => {
      assertCurrent();
      const { entries } = await reader.readEntries(
        {
          agentId: database.agentId,
          storePath: database.path,
          env: database.env,
          projection: "list",
          cleanupSession: input.cleanupSession,
          hydrateSkillPromptRefs: false,
          readConsistency: input.readConsistency,
        },
        continuation,
      );
      assertCurrent();
      return entries;
    },
    { backing: true, dataOnly: true },
  );
}

/** Keep every discovered database and original admission alive through one synchronous consumer. */
export async function withSessionEntriesFromStoresInWorker<T>(
  inputs: readonly SessionEntryWorkerRead[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => T,
  options?: SessionEntryCohortReadOptions,
): Promise<T> {
  options?.signal?.throwIfAborted();
  const prepareConsume = options?.prepareConsume;
  const originalInputs = [...inputs];
  const capturedInputs: SessionEntryWorkerRead[] = originalInputs.map((input) => {
    const captured: SessionEntryWorkerRead = {
      ...input,
      env: cloneEnvWithPlatformSemantics(input.env ?? process.env),
      snapshotFields: input.snapshotFields?.slice(),
      preparedSource: input.preparedSource && { ...input.preparedSource },
    };
    if (captured.selection) {
      captured.selection =
        captured.selection.kind === "children"
          ? { ...captured.selection, parentSessionKeys: [...captured.selection.parentSessionKeys] }
          : { ...captured.selection };
    } else {
      captured.sessionKeys = [...captured.sessionKeys];
    }
    return captured;
  });
  if (options?.ordered && !capturedInputs.some((input) => captureMemoryExactSessionReader(input))) {
    return withOrderedSessionEntriesInWorker(capturedInputs, consume, {
      readStore: (input, read) =>
        withSessionStoreReaderInWorker(input, read, {
          lane: targetDiscoveryLane,
          prepareSource: options.prepareSource?.bind(
            options,
            originalInputs[capturedInputs.indexOf(input)]!,
          ),
        }),
      onReadAdmitted: options.onReadAdmitted,
      prepareConsume,
      signal: options.signal,
    });
  }
  const reads: PreparedSessionEntryWorkerRead[] = [];
  const enter = async (index: number): Promise<T> => {
    const input = capturedInputs[index];
    if (input) {
      return withSessionEntriesFromStoreInWorker(
        input,
        async (read) => {
          reads.push(read);
          try {
            return await enter(index + 1);
          } finally {
            reads.pop();
          }
        },
        false,
        options?.prepareSource &&
          ((...source) => options.prepareSource!(originalInputs[index]!, ...source)),
        options?.signal,
      );
    }
    if (prepareConsume) {
      await prepareConsume();
    }
    options?.signal?.throwIfAborted();
    for (const read of reads) {
      read.assertCurrent();
    }
    const result = consume(reads);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Session entry read consumers must remain synchronous");
    }
    return result;
  };
  return enter(0);
}

/** The ordinary return API returns data, never a retained authority claim. */
export function readSessionEntriesFromStoreInWorker(
  input: SessionEntryWorkerRead,
  /** Register keyed publication custody after source selection, before the row-read yield. */
  prepareSource?: SessionEntryReadSourcePreparation,
) {
  return withSessionEntriesFromStoreInWorker(
    input,
    async (read) => read.result,
    true,
    prepareSource,
  );
}

export async function withSessionEntriesFromStoreInWorker<T>(
  input: SessionEntryWorkerRead,
  consume: (read: PreparedSessionEntryWorkerRead) => Promise<T>,
  dataOnly = false,
  prepareSource?: SessionEntryReadSourcePreparation,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    assertMemoryExactReadSource(input.preparedSource, memory.source);
    const projection =
      input.snapshotFields ?? (!input.projection || input.projection === "full" ? "full" : "list");
    const selection = input.selection;
    let entries: SessionEntrySummary[];
    if (!selection) {
      entries = input.sessionKeys.flatMap((key) => {
        const sessionKey = resolveSqliteSessionKey(key, memory.agentId);
        const entry = memory.read(sessionKey, projection);
        return entry ? [{ sessionKey, entry }] : [];
      });
    } else if (selection.kind === "session-id") {
      const selected = memory.readById(selection.sessionId, projection, selection.orderBy);
      entries = selected ? [selected] : [];
    } else if (selection.kind === "children") {
      entries = memory.children(selection.parentSessionKeys, projection);
    } else {
      entries = memory
        .entries(projection)
        .filter(
          ({ sessionKey, entry }) =>
            !isInternalSessionEffectsKey(sessionKey) &&
            (selection.kind === "label"
              ? entry.label === selection.label
              : sessionKey === selection.sessionIdOrKey ||
                entry.sessionId === selection.sessionIdOrKey),
        );
      entries.sort((left, right) =>
        left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0,
      );
    }
    const facts = new Map(entries.map(({ sessionKey }) => [sessionKey, memory.facts(sessionKey)]));
    const database = { agentId: memory.agentId, path: memory.path, env: input.env ?? process.env };
    const result: SessionExactEntriesWorkerResult = {
      kind: "session-exact-entries",
      entries,
      source: memory.source,
      lifecycleTimestamps: resolveSessionLifecycleTimestampsWithHeader({
        entry: entries.find(({ sessionKey }) => sessionKey === input.lifecycleSessionKey)?.entry,
        readHeader: () => undefined,
      }),
      ...(input.includeMembers
        ? { members: Object.fromEntries([...facts].map(([key, value]) => [key, value.members])) }
        : {}),
      ...(input.includeParticipantRecords
        ? {
            participantRecords: Object.fromEntries(
              [...facts].map(([key, value]) => [key, value.participants]),
            ),
          }
        : {}),
      ...(input.includeAuthorization && memory.source
        ? {
            databaseIdentity: {
              identity: memory.source.databaseIdentity,
              incarnation: memory.source.databaseIdentity,
              filename: memory.path,
            },
          }
        : {}),
      ...(input.projection === "sharing" && memory.source
        ? {
            sharing: {
              source: database,
              databaseIdentity: memory.source.databaseIdentity,
              placeholders: [],
              members: [...facts].map(([sessionKey, value]) => ({
                sessionKey,
                identityIds: value.members.map((member) => member.identityId),
              })),
            },
          }
        : {}),
    };
    return consume({ result, database, assertCurrent: () => memory.assertCurrent() });
  }
  const request = captureSessionEntryWorkerRequest(input);
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, continuation, assertCurrent }) => {
      assertCurrent();
      const result = await readSessionEntriesWithRetainedFacts(database, request, () =>
        reader.readExactEntries({ ...request, env: database.env, continuation }, signal),
      );
      signal?.throwIfAborted();
      assertCurrent();
      return consume({ result, database, assertCurrent });
    },
    { backing: input.projection === "list", lane: projectionLane, dataOnly, prepareSource },
  );
}

export async function withSessionStoreReaderInWorker<T>(
  input: SessionStoreWorkerReadInput,
  read: (source: SessionStoreWorkerReader) => Promise<T>,
  {
    backing = false,
    lane,
    dataOnly = false,
    logical,
    prepareSource,
    capturePhysicalSource = false,
  }: {
    backing?: boolean;
    lane?: SessionHistoryWorkerLane;
    dataOnly?: boolean;
    logical?: { assertCurrent?: () => void; onReadError?: (error: unknown) => Promise<T> };
    prepareSource?: SessionEntryReadSourcePreparation;
    /** Retain existing-file identity across caller preparation and final data disclosure. */
    capturePhysicalSource?: boolean;
  } = {},
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = input.agentId === undefined ? undefined : normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  const preparedSource = input.preparedSource && { ...input.preparedSource };
  const readLane = lane ?? (input.projection === "sharing" ? projectionLane : undefined);
  preparedSource?.assertCurrent();
  logical?.assertCurrent?.();
  const onReadError = logical?.onReadError;
  const inspection = isArtifactPreservingStateRead("agent");
  let selection: Awaited<ReturnType<typeof prepareSessionStoreReaderCandidates>>;
  try {
    selection = await prepareSessionStoreReaderCandidates(storePath, {
      inspection,
      preparedSource,
      allowDirect: !preparedSource && !logical,
    });
    preparedSource?.assertCurrent();
    logical?.assertCurrent?.();
  } catch (error) {
    if (!onReadError) {
      throw error;
    }
    return onReadError(error);
  }
  const { candidates, direct, target } = selection;
  const native = backing
    ? retainOpenClawAgentDatabaseReadCandidates(
        candidates.flatMap((candidate) => [
          candidate,
          { ...candidate, path: candidate.physicalPath },
        ]),
        env,
      )
    : undefined;
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  const assertSourcesCurrent = () => {
    logical?.assertCurrent?.();
    if (logical || preparedSource) {
      for (const { owner } of continuations) {
        owner.assertCurrent();
      }
    }
  };
  let assertFinalCurrent: (() => void) | undefined;
  try {
    for (const database of native?.databases ?? []) {
      const owner = captureCanonicalSessionReaderContinuation(database);
      if (owner) {
        continuations.push({
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner,
        });
      }
    }
    const readDatabase = async (
      database: { agentId: string; path: string },
      logicalAgentId: string,
      sourcePath: string,
      route: Pick<
        SessionEntryReadWorkerOwner,
        "assertCurrent" | "onRegistryChange" | "refreshBeforeDispatch" | "revalidateTarget"
      >,
    ) => {
      const continuation = continuations.find(
        (item) =>
          item.path === database.path &&
          (!logical || item.owner.receipt.agentId === database.agentId),
      )?.owner;
      let sourceIdentity =
        candidates.find(
          (candidate) => candidate.identity && candidate.physicalPath === database.path,
        )?.identity ??
        (prepareSource || capturePhysicalSource
          ? readDatabasePathIdentitySync(database.path)
          : undefined);
      const preparedDatabase = {
        ...database,
        env: { ...env },
        readIdentity: inspection ? sourceIdentity : undefined,
      };
      let sourcePrepared = false;
      const prepareRead = () => {
        if (sourcePrepared || !sourceIdentity) {
          return;
        }
        // A missing file can be created by the writer ahead of this cold read.
        // Capture it under the read's existing admission before dispatching the snapshot.
        if (!inspection && sourceIdentity.birthtime === undefined) {
          sourceIdentity = readDatabasePathIdentitySync(database.path);
        }
        prepareSource?.(preparedDatabase, sourceIdentity);
        sourcePrepared = true;
      };
      return withSessionHistoryWorkerDatabase(
        {
          ...database,
          requestedPaths: [storePath, sourcePath],
          env,
          prepareRead,
          readIdentity: inspection ? sourceIdentity : undefined,
          readSourcePath: inspection ? sourcePath : undefined,
        },
        async (reader) => {
          const assertCapturedCurrent = () => {
            assertSourcesCurrent();
            reader.assertCurrent();
            continuation?.assertCurrent();
            route.assertCurrent();
            // Discovery can yield before writable admission; retain its selected physical source.
            if (!inspection && sourceIdentity?.key.startsWith("file:")) {
              assertExistingDatabaseIdentity(
                database.path,
                sourceIdentity.key,
                sourceIdentity.birthtime,
              );
            }
          };
          if (dataOnly && (logical?.assertCurrent || preparedSource)) {
            assertFinalCurrent = assertCapturedCurrent;
          }
          assertCapturedCurrent();
          if (sourceIdentity?.birthtime !== undefined) {
            prepareRead();
          }
          return await read({
            ...route,
            reader,
            database: preparedDatabase,
            logicalAgentId,
            selectedStore: Object.freeze({ path: sourcePath, physicalPath: database.path }),
            continuation: continuation?.receipt,
            assertCurrent: assertCapturedCurrent,
          });
        },
        readLane,
      );
    };
    let result: T;
    if (preparedSource) {
      const assertPreparedCurrent = () => {
        preparedSource.assertCurrent();
        assertSessionStoreReadCandidate(preparedSource.path, candidates);
      };
      assertPreparedCurrent();
      result = await readDatabase(
        {
          agentId: preparedSource.agentId,
          path: assertSessionStoreReadCandidate(preparedSource.path, candidates),
        },
        agentId ?? preparedSource.agentId,
        preparedSource.path,
        { assertCurrent: assertPreparedCurrent },
      );
    } else if (direct && target.agentId) {
      resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
      result = await readDatabase(
        { agentId: target.agentId, path: direct.physicalPath },
        agentId ?? target.agentId,
        target.path,
        { assertCurrent: assertSourcesCurrent },
      );
    } else {
      result = await withSessionStoreTarget(
        { agentId, defaultAgentId: input.defaultAgentId, storePath, env, candidates },
        async (selected, owner) =>
          readDatabase(selected.database, selected.logicalAgentId, selected.sourcePath, owner),
        assertSourcesCurrent,
        onReadError &&
          (async (error, assertDiscoveryCurrent) => {
            assertFinalCurrent = assertDiscoveryCurrent;
            assertFinalCurrent();
            const value = await onReadError(error);
            assertFinalCurrent();
            return value;
          }),
      );
    }
    // Only returned data may be refused after cleanup; synchronous consumers can already publish.
    assertFinalCurrent?.();
    return result;
  } finally {
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    native?.release();
  }
}

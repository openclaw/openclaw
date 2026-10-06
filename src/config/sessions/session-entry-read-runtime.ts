import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-registry-listing.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { matchesPluginHostCleanupSession } from "./plugin-host-cleanup.js";
import { listSessionEntriesReadOnly } from "./session-accessor.sqlite-entry-list.read.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnlyResultInScope,
} from "./session-accessor.sqlite-entry.js";
import { resolveSqliteAgentId, resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryReadScope,
  SessionEntryReadOnlyWorkerScope,
  SessionEntrySummary,
} from "./session-accessor.types.js";
import {
  captureCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { withOrderedSessionEntriesInWorker } from "./session-entry-read-ordered.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
  captureSessionEntryWorkerRequest,
} from "./session-entry-read-request.js";
import type {
  SessionEntryWorkerRead,
  PreparedSessionEntryWorkerRead,
  SessionStoreWorkerReadInput,
  SessionStoreWorkerReadScope,
  SessionEntryReadSourcePreparation,
} from "./session-entry-read-runtime.types.js";
import type { SessionEntryListWorkerInput } from "./session-entry-read.types.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionEntry,
  withIncognitoSessionEntrySummaries,
  type IncognitoSessionBinding,
} from "./session-incognito-binding.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  maintenanceLane,
  projectionLane,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryReadWorkerOwner = {
  kind: "native" | "incognito" | "file" | "unresolved";
  incognito?: IncognitoSessionBinding;
  assertCurrent: () => void;
  scope?: SessionEntryReadOnlyWorkerScope;
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
): Promise<T> {
  const { scope, agentId } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    return withIncognitoSessionEntry(
      binding,
      resolveSqliteSessionKey(scope.sessionKey, binding.actor.agentId),
      assertCallerCurrent,
      (entry, assertCurrent) =>
        consume(ok(entry), { kind: "incognito", incognito: binding, assertCurrent }),
    );
  }
  // Incognito keeps its native existing-only owner until that owner's complete cutover.
  if (isNativeSessionEntryRead(scope, agentId)) {
    const read = loadSessionEntryReadOnlyResultInScope(scope);
    assertCallerCurrent();
    const result = await consume(read, { kind: "native", assertCurrent: assertCallerCurrent });
    assertCallerCurrent();
    return result;
  }
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
      const readScope = {
        ...scope,
        agentId: logicalAgentId,
        databaseAgentId: database.agentId,
        storePath: database.path,
        env: database.env,
      };
      const read = await reader.readEntryResult({ scope: readScope, continuation });
      owner.assertCurrent();
      const value = await consumeRead(read, { ...owner, kind: "file", scope: readScope });
      owner.assertCurrent();
      return value;
    },
    { backing: true, dataOnly: true, logical: { assertCurrent: assertCallerCurrent, onReadError } },
  );
}

/** Return entry data only after the retained physical reader has finished its currentness checks. */
export function readSessionEntryReadOnlyInWorker(
  input: SessionEntryReadScope,
  assertCallerCurrent: () => void = () => {},
): Promise<SessionEntry | undefined> {
  return withSessionEntryReadOnlyInWorker(input, assertCallerCurrent, async (read) => {
    if (!read.ok) {
      throw read.error;
    }
    return read.value;
  });
}

/** Envelope timestamps are descriptive reads; missing stores remain absent. */
export async function readSessionUpdatedAtInWorker(input: SessionAccessScope) {
  const entry = await readSessionEntryReadOnlyInWorker({ ...input, projection: "list" });
  return entry?.updatedAt;
}

/** Diagnostic identities name the default agent store, not a logical store locator. */
export async function withSessionDiagnosticTextInWorker(
  input: { agentId: string; sessionKey: string; sessionId: string },
  assertCurrent: () => void,
  consume: (text: string | undefined) => void,
): Promise<void> {
  const { scope, env } = captureSessionEntryReadScope(input);
  const agentId = normalizeAgentId(input.agentId);
  assertCurrent();
  if (isIncognitoSessionKey(scope.sessionKey)) {
    consume(undefined);
    return;
  }
  const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  const admission = resolveSessionTranscriptReadFence(input);
  await withSessionHistoryWorkerDatabase(
    { agentId, path: storePath, env },
    async (owner) => {
      assertCurrent();
      const text = await owner.readDiagnosticText({
        scope: {
          ...scope,
          agentId,
          databaseAgentId: agentId,
          storePath,
          sessionId: input.sessionId,
        },
        admission,
      });
      owner.assertCurrent();
      assertCurrent();
      consume(text);
    },
    maintenanceLane,
  );
}

/** Preserve logical lookup and writable open semantics on the canonical file-backed actor. */
export async function readSessionEntryInWorker(
  input: SessionAccessScope,
  assertCallerCurrent: () => void = () => {},
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void,
) {
  const { scope, env } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  let storePath = scope.storePath ? path.resolve(scope.storePath) : undefined;
  if (captureIncognitoSessionBinding(scope)) {
    return readSessionEntryReadOnlyInWorker(scope, assertCallerCurrent);
  }
  // Incognito still belongs to its process-held native owner until that owner's complete cutover.
  if (isNativeSessionEntryRead(scope, agentId)) {
    return loadSessionEntry(scope);
  }
  if (!storePath) {
    if (!agentId) {
      throw new Error("Cannot resolve SQLite session scope without an agent id");
    }
    storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  const loadedRead = await withSessionStoreTarget(
    { agentId, defaultAgentId: scope.defaultAgentId, storePath, env, candidates },
    async (target, owner) => {
      const sessionKey = resolveSqliteSessionKey(scope.sessionKey, target.logicalAgentId);
      const options = { ...target.database, env };
      const targetIdentity = readDatabasePathIdentitySync(options.path);
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        targetIdentity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: targetIdentity.key.slice("file:".length),
                nativeLocation: targetIdentity.canonicalPath,
                birthtime: targetIdentity.birthtime,
              },
            }
          : { expectedCreationIdentity: targetIdentity },
      );
      const assertCurrent = () => {
        execution.assertCurrent();
        owner.assertCurrent();
      };
      const source = {
        assertCurrent,
        onRegistryChange(change) {
          owner.onRegistryChange(change);
          onRegistryChange?.(change);
        },
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              assertCurrent();
              if (!grant()) {
                throw new Error("Session read authority expired");
              }
            }, binding.attachment),
          });
        },
      } satisfies AgentDatabaseRequestExecutionSource;
      let entry: SessionEntry | undefined;
      try {
        entry = await runOpenClawAgentWorkerWrite(options, async () => {
          await owner.refreshBeforeDispatch(() => execution.assertCurrent());
          execution.assertCurrent();
          await execution.prepare(source);
          return execution.runExisting(source, (worker) =>
            worker.execute({ type: "session.entry.read", input: { sessionKey } }),
          );
        });
        await owner.revalidateTarget();
        assertCurrent();
      } finally {
        await execution.release();
      }
      owner.assertCurrent();
      return { entry, assertCurrent: owner.assertCurrent };
    },
    assertCallerCurrent,
  );
  loadedRead.assertCurrent();
  return loadedRead.entry;
}

/** Read descriptive summaries through the original store selection and reader lifetime. */
export async function readSessionEntrySummariesInWorker(
  input: Omit<SessionStoreWorkerReadScope, "agentId"> &
    Pick<SessionEntryListWorkerInput["scope"], "agentId" | "cleanupSession">,
) {
  const { scope, agentId } = captureSessionEntryReadScope({ ...input, sessionKey: "" });
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    return withIncognitoSessionEntrySummaries(binding, async (entries) =>
      entries.filter(({ sessionKey, entry }) =>
        matchesPluginHostCleanupSession(sessionKey, entry, input.cleanupSession),
      ),
    );
  }
  if (isNativeSessionEntryRead(scope, agentId)) {
    // Process-held transcripts keep their existing native reader until its worker cutover.
    return listSessionEntriesReadOnly({
      ...scope,
      clone: false,
      projection: "list",
      hydrateSkillPromptRefs: false,
    })
      .filter(({ sessionKey, entry }) =>
        matchesPluginHostCleanupSession(sessionKey, entry, input.cleanupSession),
      )
      .map(({ sessionKey, entry }) => ({ sessionKey, entry: structuredClone(entry) }));
  }
  return withSessionStoreReaderInWorker(
    { ...input, env: scope.env, storePath: scope.storePath ?? input.storePath },
    async ({ reader, database, continuation, assertCurrent }) => {
      assertCurrent();
      const entries = await reader.readEntries(
        {
          agentId: database.agentId,
          storePath: database.path,
          env: database.env,
          projection: "list",
          cleanupSession: input.cleanupSession,
          hydrateSkillPromptRefs: false,
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
  options?: {
    ordered?: boolean;
    onReadAdmitted?: () => void;
    prepareSource?: (
      input: SessionEntryWorkerRead,
      ...source: Parameters<SessionEntryReadSourcePreparation>
    ) => void;
  },
): Promise<T> {
  if (options?.ordered) {
    return withOrderedSessionEntriesInWorker(inputs, consume, {
      readStore: (input, read) =>
        withSessionStoreReaderInWorker(input, read, {
          prepareSource: options.prepareSource?.bind(options, input),
        }),
      onReadAdmitted: options.onReadAdmitted,
    });
  }
  const reads: PreparedSessionEntryWorkerRead[] = [];
  const enter = (index: number): Promise<T> => {
    const input = inputs[index];
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
        options?.prepareSource && ((...source) => options.prepareSource!(input, ...source)),
      );
    }
    for (const read of reads) {
      read.assertCurrent();
    }
    let active = true;
    try {
      const result = consume(
        reads.map((read) => ({
          result: read.result,
          database: read.database,
          assertCurrent: () => {
            if (!active) {
              throw new Error("Session entry read consumer is no longer active");
            }
            read.assertCurrent();
          },
        })),
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Session entry read consumers must remain synchronous");
      }
      return Promise.resolve(result);
    } finally {
      active = false;
    }
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
): Promise<T> {
  const request = captureSessionEntryWorkerRequest(input);
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, continuation, assertCurrent }) => {
      assertCurrent();
      const result = await reader.readExactEntries({ ...request, env: database.env, continuation });
      assertCurrent();
      return consume({ result, database, assertCurrent });
    },
    { backing: input.projection === "list", dataOnly, prepareSource },
  );
}

/** Keep the physical reader owner through a registry maintenance consumer and its commit guard. */
export function withSessionRegistryEntriesInWorker<T>(
  input: SessionStoreWorkerReadScope,
  consume: (entries: SessionEntrySummary[], assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  assertAgentDatabaseAdmitted(input.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, assertCurrent: assertReaderCurrent }) => {
      const assertCurrent = () => {
        assertAgentDatabaseAdmitted(input.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
        assertReaderCurrent();
      };
      assertCurrent();
      const entries = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        cronRetention: true,
      });
      assertCurrent();
      return await consume(entries, assertCurrent);
    },
    { lane: maintenanceLane },
  );
}

/** Return owned full entries only for expired cron runs; live deletion guards stay on the host. */
export async function readExpiredCronRunEntriesInWorker(
  input: SessionStoreWorkerReadScope & { updatedBefore: number },
) {
  const expiredCronRuns = {
    agentId: normalizeAgentId(input.agentId),
    updatedBefore: input.updatedBefore,
  };
  assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, assertCurrent }) => {
      const assertAdmitted = () => {
        assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
      };
      assertAdmitted();
      const entries = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        expiredCronRuns,
      });
      assertAdmitted();
      assertCurrent();
      return entries;
    },
    { lane: maintenanceLane, dataOnly: true },
  );
}

type SessionStoreWorkerReader = Pick<
  SessionEntryReadWorkerOwner,
  "onRegistryChange" | "refreshBeforeDispatch" | "revalidateTarget"
> & {
  reader: SessionHistoryWorkerDatabase;
  database: PreparedSessionEntryWorkerRead["database"];
  logicalAgentId: string;
  selectedStore: NonNullable<SessionEntryReadWorkerOwner["selectedStore"]>;
  continuation?: CanonicalSessionReaderContinuation;
  assertCurrent: () => void;
};

export async function withSessionStoreReaderInWorker<T>(
  input: SessionStoreWorkerReadInput,
  read: (source: SessionStoreWorkerReader) => Promise<T>,
  {
    backing = false,
    lane,
    dataOnly = false,
    logical,
    prepareSource,
  }: {
    backing?: boolean;
    lane?: SessionHistoryWorkerLane;
    dataOnly?: boolean;
    logical?: { assertCurrent?: () => void; onReadError?: (error: unknown) => Promise<T> };
    prepareSource?: SessionEntryReadSourcePreparation;
  } = {},
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = input.agentId === undefined ? undefined : normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  logical?.assertCurrent?.();
  const onReadError = logical?.onReadError;
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  let candidates: SessionStoreReadCandidate[];
  let direct: SessionStoreReadCandidate | undefined;
  try {
    const captured =
      !logical && target.agentId ? captureSessionStoreReadCandidate(target.path) : undefined;
    direct = captured && captured.path === captured.physicalPath ? captured : undefined;
    candidates = direct ? [direct] : captureSessionStoreReadCandidates(storePath);
  } catch (error) {
    if (!onReadError) {
      throw error;
    }
    return onReadError(error);
  }
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
  let sourceActive = true;
  const assertSourcesCurrent = () => {
    if (!sourceActive) {
      throw new Error("Session entry read source is no longer active");
    }
    logical?.assertCurrent?.();
    if (logical) {
      for (const candidate of candidates) {
        if (
          captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
          candidate.physicalPath
        ) {
          throw new Error("Session store alias changed during discovery; retry the read.");
        }
      }
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
      return withSessionHistoryWorkerDatabase(
        { ...database, requestedPaths: [storePath, sourcePath], env },
        async (reader) => {
          const sourceIdentity = prepareSource
            ? readDatabasePathIdentitySync(database.path)
            : undefined;
          let active = true;
          const assertCapturedCurrent = () => {
            assertSourcesCurrent();
            reader.assertCurrent();
            continuation?.assertCurrent();
            route.assertCurrent();
            if (sourceIdentity?.key.startsWith("file:")) {
              assertExistingDatabaseIdentity(
                database.path,
                sourceIdentity.key,
                sourceIdentity.birthtime,
              );
            }
          };
          if (dataOnly) {
            assertFinalCurrent = assertCapturedCurrent;
          }
          const assertCurrent = () => {
            if (!active) {
              throw new Error("Session entry read consumer is no longer active");
            }
            assertCapturedCurrent();
          };
          try {
            assertCurrent();
            const preparedDatabase = { ...database, env: { ...env } };
            if (sourceIdentity) {
              prepareSource?.(preparedDatabase, sourceIdentity);
            }
            return await read({
              ...route,
              reader,
              database: preparedDatabase,
              logicalAgentId,
              selectedStore: Object.freeze({ path: sourcePath, physicalPath: database.path }),
              continuation: continuation?.receipt,
              assertCurrent,
            });
          } finally {
            active = false;
          }
        },
        lane,
      );
    };
    let result: T;
    if (direct && target.agentId) {
      resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
      result = await readDatabase(
        { agentId: target.agentId, path: direct.physicalPath },
        agentId ?? target.agentId,
        target.path,
        {
          assertCurrent: () => {
            assertSessionStoreReadCandidate(target.path, candidates);
          },
        },
      );
    } else {
      result = await withSessionStoreTarget(
        { agentId, defaultAgentId: input.defaultAgentId, storePath, env, candidates },
        async (selected, owner) =>
          readDatabase(selected.database, selected.logicalAgentId, selected.sourcePath, owner),
        assertSourcesCurrent,
        onReadError &&
          (async (error, assertDiscoveryCurrent) => {
            assertFinalCurrent = () => {
              assertSourcesCurrent();
              assertDiscoveryCurrent();
            };
            assertFinalCurrent();
            const value = await onReadError(error);
            assertFinalCurrent();
            return value;
          }),
        { lane: lane ?? (input.projection === "sharing" ? projectionLane : undefined) },
      );
    }
    // Only returned data may be refused after cleanup; synchronous consumers can already publish.
    assertFinalCurrent?.();
    return result;
  } finally {
    sourceActive = false;
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    native?.release();
  }
}

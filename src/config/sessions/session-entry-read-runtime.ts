import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import {
  listOpenIncognitoAgentDatabases,
  retainOpenClawAgentDatabaseReadCandidates,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryReadScope,
  SessionEntryReadOnlyWorkerScope,
} from "./session-accessor.types.js";
import {
  captureCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import {
  maintenanceLane,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SessionExactEntriesWorkerResult,
  SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import type { SessionEntry } from "./types.js";

function captureSessionEntryReadScope(input: SessionEntryReadScope) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = {
    ...input,
    env,
    ...(input.storePath ? { storePath: path.resolve(input.storePath) } : {}),
  };
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  return { scope, env, agentId };
}

function isNativeSessionEntryRead(scope: SessionEntryReadScope, agentId: string | undefined) {
  const storePath = scope.storePath;
  return Boolean(
    isIncognitoSessionKey(scope.sessionKey) ||
    (storePath &&
      (isIncognitoOpenClawAgentSqlitePath(storePath, {
        agentId: agentId ?? scope.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
        env: scope.env,
      }) ||
        listOpenIncognitoAgentDatabases().some((owner) => owner.storePath === storePath))),
  );
}

/** Retain a readonly logical source through an asynchronous, data-only consumer. */
export async function withSessionEntryReadOnlyInWorker<T>(
  input: SessionEntryReadScope,
  assertCallerCurrent: () => void,
  consume: (read: Result<SessionEntry | undefined, unknown>) => Promise<T>,
): Promise<T> {
  const { scope, agentId } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  // Incognito keeps its native existing-only owner until that owner's complete cutover.
  if (isNativeSessionEntryRead(scope, agentId)) {
    const read = loadSessionEntryReadOnlyResultInScope(scope);
    assertCallerCurrent();
    const result = await consume(read);
    assertCallerCurrent();
    return result;
  }
  return await withSessionEntryReadOnlyWorkerSource(scope, assertCallerCurrent, async (source) => {
    if (!source.ok) {
      return await consume(source);
    }
    const owner = source.value;
    const read = await owner.reader.readEntryResult({
      scope: owner.scope,
      continuation: owner.continuation,
    });
    owner.assertCurrent();
    return await consume(read);
  });
}

type SessionEntryReadOnlyWorkerSource = {
  scope: SessionEntryReadOnlyWorkerScope;
  reader: SessionHistoryWorkerDatabase;
  continuation?: CanonicalSessionReaderContinuation;
  assertCurrent: () => void;
};

/** Shared finite readers retain one captured file source through a data-only operation. */
async function withSessionEntryReadOnlyWorkerSource<T>(
  input: SessionEntryReadScope,
  assertCallerCurrent: () => void,
  consume: (source: Result<SessionEntryReadOnlyWorkerSource, unknown>) => Promise<T>,
): Promise<T> {
  const { scope, env, agentId } = captureSessionEntryReadScope(input);
  assertCallerCurrent();
  const consumeRead = async (read: Result<SessionEntryReadOnlyWorkerSource, unknown>) => {
    assertCallerCurrent();
    const value = await consume(read);
    assertCallerCurrent();
    return value;
  };
  let storePath = scope.storePath;
  if (!storePath) {
    if (!agentId) {
      return await consumeRead(
        err(new Error("Cannot resolve SQLite session scope without an agent id")),
      );
    }
    storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  }
  let candidates: ReturnType<typeof captureSessionStoreReadCandidates>;
  try {
    candidates = captureSessionStoreReadCandidates(storePath);
  } catch (error) {
    return await consumeRead(err(error));
  }
  const native = retainOpenClawAgentDatabaseReadCandidates(
    candidates.flatMap((candidate) => [candidate, { ...candidate, path: candidate.physicalPath }]),
    env,
  );
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  let active = true;
  const assertSourcesCurrent = () => {
    if (!active) {
      throw new Error("Session entry read source is no longer active");
    }
    assertCallerCurrent();
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
  };
  let assertReadCurrent = assertSourcesCurrent;
  try {
    for (const database of native.databases) {
      const owner = captureCanonicalSessionReaderContinuation(database);
      if (owner) {
        continuations.push({
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner,
        });
      }
    }
    const value = await withSessionStoreTarget(
      { agentId, defaultAgentId: scope.defaultAgentId, storePath, env: { ...env }, candidates },
      async (target, route) => {
        const database = target.database;
        return await withSessionHistoryWorkerDatabase({ ...database, env }, async (owner) => {
          assertReadCurrent = () => {
            assertSourcesCurrent();
            route.assertCurrent();
            owner.assertCurrent();
          };
          assertReadCurrent();
          const result = await consumeRead(
            ok({
              scope: {
                ...scope,
                agentId: target.logicalAgentId,
                databaseAgentId: database.agentId,
                storePath: database.path,
                env: { ...env },
              },
              reader: owner,
              assertCurrent: assertReadCurrent,
              continuation: continuations.find(
                (item) =>
                  item.path === database.path && item.owner.receipt.agentId === database.agentId,
              )?.owner.receipt,
            }),
          );
          assertReadCurrent();
          return result;
        });
      },
      assertSourcesCurrent,
      async (error, assertDiscoveryCurrent) => {
        assertReadCurrent = () => {
          assertSourcesCurrent();
          assertDiscoveryCurrent();
        };
        assertReadCurrent();
        const result = await consumeRead(err(error));
        assertReadCurrent();
        return result;
      },
    );
    // Worker retirement yields; source changes there still precede disclosure of this data.
    assertReadCurrent();
    return value;
  } finally {
    active = false;
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    native.release();
  }
}

type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

type SessionEntryWorkerRead = SessionStoreWorkerReadScope & {
  sessionKeys: readonly string[];
  lifecycleSessionKey?: string;
  projection?: "full" | "backing" | "sharing";
  includeMembers?: boolean;
  includeAuthorization?: boolean;
};

export type PreparedSessionEntryWorkerRead = {
  result: SessionExactEntriesWorkerResult;
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  assertCurrent: () => void;
};

/** Keep every discovered database and original admission alive through one synchronous consumer. */
export async function withSessionEntriesFromStoresInWorker<T>(
  inputs: readonly SessionEntryWorkerRead[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => T,
): Promise<T> {
  const reads: PreparedSessionEntryWorkerRead[] = [];
  const enter = (index: number): Promise<T> => {
    const input = inputs[index];
    if (input) {
      return withSessionEntriesFromStoreInWorker(input, async (read) => {
        reads.push(read);
        try {
          return await enter(index + 1);
        } finally {
          reads.pop();
        }
      });
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
export function readSessionEntriesFromStoreInWorker(input: SessionEntryWorkerRead) {
  return withSessionEntriesFromStoreInWorker(input, async (read) => read.result, true);
}

async function withSessionEntriesFromStoreInWorker<T>(
  input: SessionEntryWorkerRead,
  consume: (read: PreparedSessionEntryWorkerRead) => Promise<T>,
  dataOnly = false,
): Promise<T> {
  const request = {
    sessionKeys: [...new Set(input.sessionKeys)],
    lifecycleSessionKey: input.lifecycleSessionKey,
    projection: input.projection,
    includeMembers: input.includeMembers,
    includeAuthorization: input.includeAuthorization,
  };
  return withSessionStoreReaderInWorker(
    input,
    async (owner, database, continuation, assertCurrent) => {
      const result = await owner.readExactEntries({ ...request, env: database.env, continuation });
      assertCurrent();
      return consume({ result, database, assertCurrent });
    },
    { backing: input.projection === "backing", dataOnly },
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
    async (owner, database, _continuation, assertCurrent) => {
      const assertAdmitted = () => {
        assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
      };
      assertAdmitted();
      const entries = await owner.readEntries({
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

async function withSessionStoreReaderInWorker<T>(
  input: SessionStoreWorkerReadScope,
  read: (
    owner: SessionHistoryWorkerDatabase,
    database: PreparedSessionEntryWorkerRead["database"],
    continuation: CanonicalSessionReaderContinuation | undefined,
    assertCurrent: () => void,
  ) => Promise<T>,
  {
    backing = false,
    lane,
    dataOnly = false,
  }: {
    backing?: boolean;
    lane?: SessionHistoryWorkerLane;
    dataOnly?: boolean;
  } = {},
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const captured = captureSessionStoreReadCandidate(target.path);
  const direct = target.agentId && captured.path === captured.physicalPath;
  const candidates = direct ? [captured] : captureSessionStoreReadCandidates(storePath);
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
      assertRoute: () => void,
    ) => {
      const continuation = continuations.find((item) => item.path === database.path)?.owner;
      return withSessionHistoryWorkerDatabase(
        { ...database, env },
        async (owner) => {
          let active = true;
          const assertCapturedCurrent = () => {
            owner.assertCurrent();
            continuation?.assertCurrent();
            assertRoute();
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
            return await read(
              owner,
              { ...database, env: { ...env } },
              continuation?.receipt,
              assertCurrent,
            );
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
      result = await readDatabase({ agentId: target.agentId, path: captured.physicalPath }, () =>
        assertSessionStoreReadCandidate(target.path, [captured]),
      );
    } else {
      result = await withSessionStoreTarget(
        { agentId, storePath, env, candidates },
        async (selected, owner) => await readDatabase(selected.database, owner.assertCurrent),
        undefined,
        undefined,
        { lane },
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

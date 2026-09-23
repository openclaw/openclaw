import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { normalizeAgentId } from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope.js";
import {
  captureCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import {
  maintenanceLane,
  withSessionHistoryWorkerReadCandidates,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SessionExactEntriesWorkerResult,
  SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";

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
    if (direct && target.agentId) {
      resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
      const result = await readDatabase(
        { agentId: target.agentId, path: captured.physicalPath },
        () => assertSessionStoreReadCandidate(target.path, [captured]),
      );
      assertFinalCurrent?.();
      return result;
    }
    const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    const result = await withSessionHistoryWorkerReadCandidates(
      candidates,
      async (discovery) => {
        const request = { agentId, storePath, env };
        let resolved = await discovery.readStoreTarget({
          ...request,
          registeredDatabases: { status: "deferred" },
        });
        let assertRegistryCurrent: (() => void) | undefined;
        if (resolved.kind === "session-target-registry-required") {
          const registry = await registryRead.read();
          assertRegistryCurrent = registry.assertCurrent;
          registry.assertCurrent();
          discovery.assertCurrent();
          resolved = await discovery.readStoreTarget({
            ...request,
            registeredDatabases:
              registry.result.status === "available"
                ? registry.result.entries
                : { status: "unavailable" },
          });
          if (resolved.kind === "session-target-registry-required") {
            throw new Error("Session store target requested registry rows twice");
          }
        }
        assertRegistryCurrent?.();
        discovery.assertCurrent();
        const selected = resolved;
        return await readDatabase(selected.database, () => {
          assertRegistryCurrent?.();
          discovery.assertCurrent();
          assertSessionStoreReadCandidate(selected.sourcePath, candidates);
        });
      },
      lane,
    );
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

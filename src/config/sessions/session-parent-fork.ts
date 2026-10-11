import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { retainSqliteWorkerErrorCode } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { forkCliSessionBindings } from "./cli-session-binding.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  formatLegacySqliteSessionMarkerForScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type { ForkSessionFromParentTranscriptParams } from "./session-accessor.types.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionForkOperation } from "./session-fork-domain.js";
import type {
  ParentForkCandidate,
  ParentForkCommit,
  ParentForkEntryParams,
  ParentForkEntryPatch,
} from "./session-parent-fork.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreCandidateIdentities } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type ForkStoreScope = { agentId?: string; sessionKey: string; storePath: string };
type ForkOwner = Pick<
  ReturnType<typeof captureForkWorker>,
  "scope" | "database" | "assertCurrent" | "prepareEntry" | "readSource" | "restore" | "commit"
>;
type ForkDiscoveryOwner = Parameters<Parameters<typeof withSessionStoreTarget>[1]>[1];

/** Only durable runtime stores use the parent-fork worker. */
export function supportsParentForkWorker(scope: ForkStoreScope): boolean {
  if (!isMainThread || isIncognitoSessionKey(scope.sessionKey)) {
    return false;
  }
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
  return supportsOpenClawAgentDatabaseExecution({
    agentId: normalizeAgentId(
      scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId ?? target.agentId,
    ),
    path: target.path,
  });
}

function withForkWorkers<T>(
  scopes: { source: ForkStoreScope; target?: ForkStoreScope },
  guard: (() => void) | undefined,
  run: (source: ForkOwner, target?: ForkOwner) => Promise<T>,
): Promise<T> {
  guard?.();
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const captureRequest = (scope: ForkStoreScope) => ({
    ...scope,
    agentId: scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId,
    storePath: path.resolve(scope.storePath),
    env,
  });
  const sourceRequest = captureRequest(scopes.source);
  const targetRequest = scopes.target ? captureRequest(scopes.target) : undefined;
  const requests = targetRequest ? [sourceRequest, targetRequest] : [sourceRequest];
  // The outer discovery retains both stores before either target lookup can yield.
  const candidates = requests.flatMap((request) =>
    captureSessionStoreReadCandidates(request.storePath),
  );
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const discoveries: ForkDiscoveryOwner[] = [];
  const owners: Array<ReturnType<typeof captureForkWorker>> = [];
  const assertCurrent = () => {
    guard?.();
    for (const discovery of discoveries) {
      discovery.assertCurrent();
    }
    for (const owner of owners) {
      owner.execution.assertCurrent();
    }
  };
  const onRegistryChange = (change: AgentDatabaseRegistryChange) => {
    for (const discovery of discoveries) {
      discovery.onRegistryChange(change);
    }
  };
  const revalidateTarget = async () => {
    for (const discovery of discoveries) {
      await discovery.revalidateTarget();
    }
    assertCurrent();
  };
  const withOwner = (
    request: ReturnType<typeof captureRequest>,
    operation: (owner: ReturnType<typeof captureForkWorker>) => Promise<T>,
  ): Promise<T> => {
    return withSessionStoreTarget(
      { ...request, candidates },
      async (target, discovery) => {
        discoveries.push(discovery);
        const observed = readDatabasePathIdentitySync(target.database.path);
        const captured = identities.get(target.database.path);
        if (
          captured
            ? observed.key !== captured.key || observed.birthtime !== captured.birthtime
            : observed.key.startsWith("file:")
        ) {
          throw new Error("Parent fork database changed during target discovery");
        }
        const existing = owners.find(
          (owner) =>
            owner.scope.agentId === target.logicalAgentId &&
            owner.database.agentId === target.database.agentId &&
            owner.database.path === target.database.path,
        );
        if (existing) {
          return operation(existing);
        }
        const owner = captureForkWorker(
          {
            agentId: target.logicalAgentId,
            databaseAgentId: target.database.agentId,
            sessionKey: resolveSqliteSessionKey(request.sessionKey, target.logicalAgentId),
            ownerStorePath: request.storePath,
            path: target.database.path,
            env,
          },
          { ...discovery, assertCurrent, onRegistryChange, revalidateTarget },
          captured ?? observed,
        );
        owners.push(owner);
        return settleForkOwner(owner, () => operation(owner));
      },
      guard,
    );
  };
  let completed: { value: T } | undefined;
  const complete = async (
    source: ReturnType<typeof captureForkWorker>,
    target?: ReturnType<typeof captureForkWorker>,
  ) => {
    const value = await run(source, target);
    completed = { value };
    return value;
  };
  return withOwner(sourceRequest, (source) =>
    targetRequest
      ? withOwner(targetRequest, (target) => complete(source, target))
      : complete(source),
  ).catch((error: unknown) => {
    if (!completed) {
      throw error;
    }
    try {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "Session fork completed before owner cleanup failed",
        { errors: [formatErrorMessage(error)] },
      );
    } catch {
      // Diagnostics cannot make an acknowledged mutation appear replayable.
    }
    return completed.value;
  });
}

function captureForkWorker(
  scope: ResolvedSqliteScope & { path: string },
  discovery: ForkDiscoveryOwner,
  identity: ReturnType<typeof readDatabasePathIdentitySync>,
) {
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const execution = captureOpenClawAgentDatabaseExecution(
    database,
    identity.key.startsWith("file:")
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: identity.key.slice("file:".length),
            nativeLocation: identity.canonicalPath,
            birthtime: identity.birthtime,
          },
        }
      : { expectedCreationIdentity: identity },
  );
  const assertCurrent = () => {
    execution.assertCurrent();
    discovery.assertCurrent();
  };
  const read = <T>(consume: Parameters<typeof withSessionEntryWorker<T>>[3]) => {
    return withSessionEntryWorker(
      database,
      undefined,
      assertCurrent,
      async (reader, source, context) => {
        source.onRegistryChange = discovery.onRegistryChange;
        await discovery.refreshBeforeDispatch(() => reader.assertCurrent());
        const result = await consume(reader, source, context);
        await discovery.revalidateTarget();
        return result;
      },
      undefined,
      execution,
    );
  };
  return {
    scope,
    database,
    execution,
    assertCurrent,
    prepareEntry: (input: ParentForkEntryParams) =>
      read(async (reader, source) => {
        await reader.prepare(source);
        return reader.runExisting(source, (worker) =>
          executeSessionForkOperation(worker, database.agentId, {
            type: "session.parentFork.prepare",
            input,
          }),
        );
      }),
    readSource: (input: { sessionId: string; forkFrom?: "last-completed" }) =>
      read(async (reader, source) => {
        await reader.prepare(source);
        return reader.runExisting(source, (worker) =>
          executeSessionForkOperation(worker, database.agentId, {
            type: "session.parentFork.source",
            input,
          }),
        );
      }),
    restore: (sessionId: string) =>
      restoreSessionColdTranscript(
        { ...scope, storePath: database.path, sessionId },
        assertCurrent,
      ),
    commit(input: ParentForkCommit) {
      return runSessionEntryWorkerOperation<ParentForkCandidate, ParentForkCandidate["result"]>({
        database,
        agentId: scope.agentId,
        assertCurrent,
        retainedExecution: execution,
        candidateKind: "session-parent-fork",
        prepareWorker(_execution, source) {
          source.onRegistryChange = discovery.onRegistryChange;
          return {
            prepare: discovery.revalidateTarget,
            beforeWrite: assertCurrent,
            release: async () => {},
          };
        },
        run: (worker, commit) =>
          commit(() =>
            executeSessionForkOperation(worker, database.agentId, {
              type: "session.parentFork.commit",
              input,
            }),
          ),
        onCommitted(candidate, published, committedIdentity) {
          if (published) {
            publishCommittedSessionIdentity(
              scope.agentId,
              committedIdentity,
              published.previous,
              published.current,
              published.prepared,
            );
          }
          return candidate.result;
        },
      });
    },
  };
}

export async function forkParentEntryInWorker(
  params: ParentForkEntryParams & { commitGuard?: () => void },
  patch?: ParentForkEntryPatch,
) {
  const { commitGuard: _guard, ...serializable } = params;
  const planned = structuredClone(serializable);
  const plannedPatch = patch ? structuredClone(patch) : undefined;
  return withForkWorkers(
    {
      source: {
        agentId: params.agentId,
        sessionKey: "",
        storePath: params.storePath,
      },
    },
    params.commitGuard,
    async (owner) => {
      const prepared = await owner.prepareEntry(planned);
      owner.assertCurrent();
      if (!prepared?.parentEntry?.sessionId) {
        return { status: "missing-parent" as const };
      }
      if (!prepared.base) {
        return { status: "missing-entry" as const };
      }
      const skipExisting = plannedPatch?.skipExisting && prepared.base.sessionId?.trim();
      let cliSessionBindings;
      if (!skipExisting) {
        await owner.restore(prepared.parentEntry.sessionId);
        const { cliBackendSupportsSessionFork } = await import("../../agents/cli-backends.js");
        owner.assertCurrent();
        cliSessionBindings = forkCliSessionBindings(
          prepared.parentEntry,
          cliBackendSupportsSessionFork,
        );
      }
      const result = await owner.commit({
        kind: "entry",
        agentId: owner.scope.agentId,
        params: planned,
        prepared,
        patch: plannedPatch,
        cliSessionBindings,
      });
      if (result.status === "created" || result.status === "too-large") {
        throw new Error("Parent entry fork returned a transcript-only result");
      }
      return result;
    },
  );
}

export async function forkParentTranscriptInWorker(params: ForkSessionFromParentTranscriptParams) {
  const { commitGuard: _guard, ...serializable } = params;
  const planned = structuredClone(serializable);
  return withForkWorkers(
    {
      source: {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      target: params.targetStorePath
        ? { sessionKey: params.sessionKey, storePath: params.targetStorePath }
        : undefined,
    },
    params.commitGuard,
    async (source, target) => {
      const crossDatabase =
        target &&
        (target.scope.agentId !== source.scope.agentId ||
          target.database.path !== source.database.path);
      const destination = crossDatabase ? target : source;
      if (!planned.parentEntry.sessionId) {
        return { status: "missing-parent" as const };
      }
      await source.restore(planned.parentEntry.sessionId);
      source.assertCurrent();
      const snapshot = crossDatabase
        ? await source.readSource({
            sessionId: planned.parentEntry.sessionId,
            forkFrom: planned.forkFrom,
          })
        : undefined;
      source.assertCurrent();
      const result = await destination.commit({
        kind: "transcript",
        agentId: destination.scope.agentId,
        params: planned,
        source: crossDatabase ? (snapshot ?? null) : undefined,
        parentSessionFile: formatLegacySqliteSessionMarkerForScope({
          ...source.scope,
          sessionId: planned.parentEntry.sessionId,
          sessionKey: planned.parentSessionKey,
        }),
      });
      if (
        result.status === "forked" ||
        result.status === "skipped" ||
        result.status === "missing-entry"
      ) {
        throw new Error("Parent transcript fork returned an entry-only result");
      }
      return result;
    },
  );
}

async function settleForkOwner<T>(
  owner: ReturnType<typeof captureForkWorker>,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = await run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await owner.execution.release();
  } catch (error) {
    if (outcome.ok) {
      throw error;
    }
    throw retainSqliteWorkerErrorCode(
      createSqliteLifecycleAggregateError(
        [outcome.error, error],
        "Session fork and executor cleanup failed",
        outcome.error,
      ),
      outcome.error,
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

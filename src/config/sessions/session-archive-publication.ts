import path from "node:path";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import {
  transcriptArchiveIdentityKey,
  uniqueTranscriptArchives,
} from "./session-accessor.sqlite-archive-store-kernel.js";
import type {
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "./session-accessor.sqlite-archive-types.js";
import { runSqliteTranscriptArchivePublishWorker } from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteTranscriptArchiveDirectory,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";

/** Publish committed archives through the caller's canonical physical owner and live authority. */
export function publishSessionStateArchivesInWorker(params: {
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "databaseAgentId" | "env" | "ownerStorePath"> & {
    path: string;
  };
  requested: readonly SessionLifecycleArchivedTranscript[];
  databaseIdentity?: string;
  retainedExecution?: OpenClawAgentDatabaseExecution;
  signal?: AbortSignal;
  assertCurrent(): void;
}): Promise<SessionLifecycleArchivedTranscript[]> {
  const database = { ...toDatabaseOptions(params.scope), path: params.scope.path };
  const source = readDatabasePathIdentitySync(database.path);
  const databaseIdentity =
    params.databaseIdentity ??
    params.retainedExecution?.fileIdentity?.physicalIdentity ??
    (source.key.startsWith("file:") ? source.key.slice(5) : undefined);
  if (!databaseIdentity || source.key !== `file:${databaseIdentity}`) {
    throw new Error("Session archive publication lost its captured database identity");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    params.retainedExecution?.assertCurrent();
    assertExistingDatabaseIdentity(database.path, source.key, source.birthtime);
  };
  let nativeLocation: string | undefined;
  const run = <T>(execute: (worker: AgentDatabaseExecutionScope) => Promise<T>) =>
    withSessionEntryWorker(
      database,
      databaseIdentity,
      assertCurrent,
      async (execution, owner) => {
        const result = await execution.runExisting(owner, async (worker) => ({
          value: await execute(worker),
        }));
        if (!result) {
          throw new Error("Session database disappeared before archive publication");
        }
        const native = execution.fileIdentity;
        if (!native || native.physicalIdentity !== databaseIdentity) {
          throw new Error("Session archive publication changed its captured native owner");
        }
        nativeLocation = native.nativeLocation;
        assertCurrent();
        return result.value;
      },
      undefined,
      params.retainedExecution,
      params.signal,
    );
  return publishPreparedSessionStateArchives(
    params.requested,
    {
      assertCurrent,
      async prepare(requested) {
        const plans = await run((worker) =>
          worker.execute({
            type: "session.archives.preparePublication",
            input: {
              archiveDirectory: resolveSqliteTranscriptArchiveDirectory(params.scope),
              requested,
            },
          }),
        );
        assertCurrent();
        for (const plan of plans) {
          if (
            plan.agentId !== database.agentId ||
            nativeLocation === undefined ||
            path.resolve(plan.databasePath) !== path.resolve(nativeLocation)
          ) {
            throw new Error("Session archive publication changed its captured database owner");
          }
          plan.databasePath = database.path;
          plan.databaseIdentity = databaseIdentity;
        }
        return plans;
      },
      record: (results) =>
        run((worker) =>
          worker.execute({
            type: "session.archives.recordPublication",
            input: { results, nowMs: Date.now() },
          }),
        ),
    },
    params.signal,
  );
}

type SessionArchivePublicationStorage = {
  assertCurrent?(): void;
  prepare(
    requested: readonly SessionLifecycleArchivedTranscript[],
  ): Promise<TranscriptArchivePublishPlan[]>;
  record(results: readonly TranscriptArchivePublishResult[]): Promise<void>;
};

export async function publishPreparedSessionStateArchives(
  requested: readonly SessionLifecycleArchivedTranscript[],
  storage: SessionArchivePublicationStorage,
  signal?: AbortSignal,
): Promise<SessionLifecycleArchivedTranscript[]> {
  const requestedArchives = uniqueTranscriptArchives(requested);
  const requestedIdentitySet = new Set(
    requestedArchives.map((archive) =>
      transcriptArchiveIdentityKey(archive.sessionId, archive.generation),
    ),
  );
  let includeRequested = true;
  while (true) {
    storage.assertCurrent?.();
    const requestedForPass = includeRequested ? requestedArchives : [];
    const plans = await storage.prepare(requestedForPass);
    storage.assertCurrent?.();
    includeRequested = false;
    if (plans.length === 0) {
      break;
    }

    const results = await runSqliteTranscriptArchivePublishWorker(plans, signal);
    storage.assertCurrent?.();
    await storage.record(results);
    storage.assertCurrent?.();

    const planByIdentity = new Map(
      plans.map((plan) => [transcriptArchiveIdentityKey(plan.sessionId, plan.generation), plan]),
    );
    emitArchivedTranscriptUpdates(
      results.flatMap((result) => {
        const identity = transcriptArchiveIdentityKey(result.sessionId, result.generation);
        if (!result.archivedPath || requestedIdentitySet.has(identity)) {
          return [];
        }
        const plan = planByIdentity.get(identity);
        return plan
          ? [
              {
                archivedPath: result.archivedPath,
                generation: result.generation,
                sessionId: result.sessionId,
                sourcePath: path.join(plan.archiveDirectory, `${result.sessionId}.jsonl`),
              },
            ]
          : [];
      }),
    );
    const failedIds = results.flatMap((result) => (result.archivedPath ? [] : [result.sessionId]));
    if (failedIds.length > 0) {
      throw new Error(
        `Session deletion committed, but ${failedIds.length} transcript archive file export(s) remain pending in SQLite; retry the operation to publish them.`,
      );
    }
  }
  return [...requested];
}

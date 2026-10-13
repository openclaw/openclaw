import path from "node:path";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
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
  assertCurrent(): void;
}): Promise<SessionLifecycleArchivedTranscript[]> {
  const database = { ...toDatabaseOptions(params.scope), path: params.scope.path };
  const source = readDatabasePathIdentitySync(database.path);
  const databaseIdentity =
    params.databaseIdentity ?? params.retainedExecution?.fileIdentity?.physicalIdentity;
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
    );
  return publishSessionStateArchives(params.scope, params.requested, {
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
  });
}

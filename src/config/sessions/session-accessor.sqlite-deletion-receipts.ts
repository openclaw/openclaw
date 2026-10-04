import type { AgentHarnessSessionDeletionTarget } from "../../agents/harness/session-deletion.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../../state/github-personal-publication-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";

export type IncognitoDeletionSource = Pick<
  IncognitoAgentDatabaseExecution,
  "agentId" | "path" | "assertCurrent"
> & {
  sessions: Pick<IncognitoAgentDatabaseExecution["sessions"], "captureSnapshot" | "readSharing">;
};

export function pinSqliteSessionReceiptDeletionDatabase(
  databaseOptions: OpenClawAgentDatabaseOptions & { agentId: string },
  actor?: IncognitoDeletionSource,
) {
  // File custody survives native maintenance closing and revoking the captured execution.
  const receiptDatabase = actor
    ? undefined
    : readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(databaseOptions));
  return { databaseOptions, actor, receiptDatabase };
}

export async function prepareSqliteSessionReceiptDeletions(
  source: ReturnType<typeof pinSqliteSessionReceiptDeletionDatabase>,
  receiptOnlyTargets: readonly AgentHarnessSessionDeletionTarget[],
  options: {
    env?: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    assertRepositoryCurrent: () => void;
    workerBacked: boolean;
  },
): Promise<() => Promise<void>> {
  const { databaseOptions, actor, receiptDatabase } = source;
  const { env, assertCurrent, assertRepositoryCurrent, workerBacked } = options;
  const receiptOnlyDeletions = new Map<
    string,
    Awaited<ReturnType<typeof preparePersonalGitHubSessionReceiptDeletion>>
  >();
  for (const target of receiptOnlyTargets) {
    receiptOnlyDeletions.set(
      target.sessionKey,
      await preparePersonalGitHubSessionReceiptDeletion({
        agentId: target.agentId,
        env,
        generations: [
          {
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision ?? null,
          },
        ],
        assertCurrent,
      }),
    );
  }
  return async () => {
    // Receipt selection is generation-precise; unlike workspaces, it needs no source binding
    // or transaction-held session absence admission after the post-run presence check.
    for (const target of receiptOnlyTargets) {
      const assertSourceCurrent = () => {
        assertRepositoryCurrent();
        actor?.assertCurrent();
        if (receiptDatabase) {
          assertExistingDatabaseIdentity(
            receiptDatabase.canonicalPath,
            receiptDatabase.key,
            receiptDatabase.birthtime,
          );
        }
      };
      assertSourceCurrent();
      let present: boolean;
      if (actor) {
        present = actor.sessions.readSharing(target.sessionKey)?.entry !== undefined;
      } else if (workerBacked) {
        const { withSessionEntryReadOnlyInWorker } =
          await import("./session-entry-read-runtime.js");
        // Read the database this deletion wrote; legacy rows can carry another agent's key.
        const readScope = {
          agentId: databaseOptions.agentId,
          defaultAgentId: databaseOptions.agentId,
          storePath: receiptDatabase?.canonicalPath,
          sessionKey: target.sessionKey,
          env,
        };
        present = await withSessionEntryReadOnlyInWorker(
          readScope,
          assertSourceCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw read.error;
            }
            if (
              owner.kind !== "file" ||
              owner.selectedStore?.physicalPath !== receiptDatabase?.canonicalPath ||
              owner.scope?.databaseAgentId !== databaseOptions.agentId
            ) {
              throw new Error("Receipt cleanup lost its pinned session database");
            }
            return read.value !== undefined;
          },
        );
      } else {
        present =
          readSessionEntryRow(
            openOpenClawAgentDatabase({
              ...databaseOptions,
              path: receiptDatabase?.canonicalPath,
            }),
            target.sessionKey,
          ) !== undefined;
      }
      if (!present) {
        await receiptOnlyDeletions.get(target.sessionKey)!(assertSourceCurrent);
      }
    }
  };
}

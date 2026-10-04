import type { AgentHarnessSessionDeletionTarget } from "../../agents/harness/session-deletion.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../../state/github-personal-publication-lifecycle.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";

export type IncognitoDeletionSource = Pick<
  IncognitoAgentDatabaseExecution,
  "agentId" | "path" | "assertCurrent"
> & {
  sessions: Pick<IncognitoAgentDatabaseExecution["sessions"], "captureSnapshot" | "readSharing">;
};

type ReceiptDeletionSource =
  | { actor: IncognitoDeletionSource }
  | {
      databaseOptions: OpenClawAgentDatabaseOptions & { agentId: string };
      database: DatabasePathIdentity;
    };

export function pinSqliteSessionReceiptDeletionDatabase(
  databaseOptions: OpenClawAgentDatabaseOptions & { agentId: string },
  actor?: IncognitoDeletionSource,
): ReceiptDeletionSource | undefined {
  if (actor) {
    return { actor };
  }
  // Native-only scopes (incognito paths, maintenance authority) cannot be read off the main
  // thread and may not be regular files; their deletions keep main's receipt behavior.
  if (!supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    return undefined;
  }
  // File custody survives native maintenance closing and revoking the captured execution.
  return {
    databaseOptions,
    database: readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(databaseOptions)),
  };
}

export async function prepareSqliteSessionReceiptDeletions(
  source: ReceiptDeletionSource,
  receiptOnlyTargets: readonly AgentHarnessSessionDeletionTarget[],
  options: {
    env?: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    assertRepositoryCurrent: () => void;
  },
): Promise<() => Promise<void>> {
  const { env, assertCurrent, assertRepositoryCurrent } = options;
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
  const assertSourceCurrent = () => {
    assertRepositoryCurrent();
    if ("actor" in source) {
      source.actor.assertCurrent();
    } else {
      const { database } = source;
      assertExistingDatabaseIdentity(database.canonicalPath, database.key, database.birthtime);
    }
  };
  const isPresent = async (sessionKey: string): Promise<boolean> => {
    if ("actor" in source) {
      return source.actor.sessions.readSharing(sessionKey)?.entry !== undefined;
    }
    const { databaseOptions, database } = source;
    const { withSessionEntryReadOnlyInWorker } = await import("./session-entry-read-runtime.js");
    // Read the database this deletion wrote; legacy rows can carry another agent's key.
    const readScope = {
      agentId: databaseOptions.agentId,
      defaultAgentId: databaseOptions.agentId,
      storePath: database.canonicalPath,
      sessionKey,
      env,
    };
    return await withSessionEntryReadOnlyInWorker(
      readScope,
      assertSourceCurrent,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (
          owner.kind !== "file" ||
          owner.selectedStore?.physicalPath !== database.canonicalPath ||
          owner.scope?.databaseAgentId !== databaseOptions.agentId
        ) {
          throw new Error("Receipt cleanup lost its pinned session database");
        }
        return read.value !== undefined;
      },
    );
  };
  return async () => {
    // Receipt selection is generation-precise; unlike workspaces, it needs no source binding
    // or transaction-held session absence admission after the post-run presence check.
    for (const target of receiptOnlyTargets) {
      assertSourceCurrent();
      if (!(await isPresent(target.sessionKey))) {
        await receiptOnlyDeletions.get(target.sessionKey)!(assertSourceCurrent);
      }
    }
  };
}

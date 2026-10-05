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
  const receiptOnlyDeletions: Array<
    Awaited<ReturnType<typeof preparePersonalGitHubSessionReceiptDeletion>>
  > = [];
  const targetsByAgent = new Map<string, AgentHarnessSessionDeletionTarget[]>();
  for (const target of receiptOnlyTargets) {
    const targets = targetsByAgent.get(target.agentId) ?? [];
    targets.push(target);
    targetsByAgent.set(target.agentId, targets);
  }
  for (const [agentId, targets] of targetsByAgent) {
    receiptOnlyDeletions.push(
      await preparePersonalGitHubSessionReceiptDeletion({
        agentId,
        env,
        generations: targets.map((target) => ({
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          lifecycleRevision: target.lifecycleRevision ?? null,
        })),
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
  const sessionKeys = receiptOnlyTargets.map((target) => target.sessionKey);
  const readPresentKeys = async (): Promise<Set<string>> => {
    if ("actor" in source) {
      return new Set(
        sessionKeys.filter((sessionKey) => source.actor.sessions.readSharing(sessionKey)?.entry),
      );
    }
    const { databaseOptions, database } = source;
    const { withSessionStoreReaderInWorker } = await import("./session-entry-read-runtime.js");
    // Read the database this deletion wrote; legacy rows can carry another agent's key.
    const readScope = {
      agentId: databaseOptions.agentId,
      defaultAgentId: databaseOptions.agentId,
      storePath: database.canonicalPath,
      env,
    };
    return await withSessionStoreReaderInWorker(
      readScope,
      async (owner) => {
        if (
          owner.selectedStore.physicalPath !== database.canonicalPath ||
          owner.database.agentId !== databaseOptions.agentId
        ) {
          throw new Error("Receipt cleanup lost its pinned session database");
        }
        owner.assertCurrent();
        const read = await owner.reader.readExactEntries({
          env: owner.database.env,
          sessionKeys,
          projection: "exact",
          snapshotFields: [],
          continuation: owner.continuation,
        });
        owner.assertCurrent();
        return new Set(read.entries.map((entry) => entry.sessionKey));
      },
      { logical: { assertCurrent: assertSourceCurrent }, dataOnly: true },
    );
  };
  return async () => {
    // Receipt selection is generation-precise; unlike workspaces, it needs no source binding
    // or transaction-held session absence admission after the post-run presence check.
    assertSourceCurrent();
    const present = await readPresentKeys();
    for (const settle of receiptOnlyDeletions) {
      await settle({
        assertCurrent: assertSourceCurrent,
        retainedSessionKeys: present,
      });
    }
  };
}

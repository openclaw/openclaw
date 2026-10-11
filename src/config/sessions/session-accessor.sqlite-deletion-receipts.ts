import type { AgentHarnessSessionDeletionTarget } from "../../agents/harness/session-deletion.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../../state/github-personal-publication-lifecycle.js";
import type { GitHubSessionReceiptGeneration } from "../../state/github-publication-read.types.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { memorySessionActorOwners } from "./session-actor-memory-owner.js";

export type MemorySessionDeletionSource = Pick<
  ReturnType<typeof memorySessionActorOwners.get>,
  "agentId" | "path" | "assertCurrent" | "readSession"
>;

type ReceiptDeletionSource =
  | { memory: MemorySessionDeletionSource }
  | {
      databaseOptions: OpenClawAgentDatabaseOptions & { agentId: string };
      database: DatabasePathIdentity;
    };

export type SessionReceiptDeletionGeneration = GitHubSessionReceiptGeneration & { agentId: string };

export function pinSqliteSessionReceiptDeletionDatabase(
  databaseOptions: OpenClawAgentDatabaseOptions & { agentId: string },
  memory?: MemorySessionDeletionSource,
): ReceiptDeletionSource | undefined {
  if (memory) {
    return { memory };
  }
  // Explicit native maintenance may not select a regular file.
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
  source: ReceiptDeletionSource | undefined,
  targets: readonly AgentHarnessSessionDeletionTarget[],
  options: {
    receiptsOnCommit?: { generations: readonly SessionReceiptDeletionGeneration[] };
    repositorySessionKeys: readonly string[];
    env?: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    assertRepositoryCurrent: () => void;
  },
) {
  const { env, assertCurrent, assertRepositoryCurrent } = options;
  const receiptOnlyTargets = source
    ? targets.filter((target) => !options.repositorySessionKeys.includes(target.sessionKey))
    : [];
  const receiptDeletions: Array<
    Awaited<ReturnType<typeof preparePersonalGitHubSessionReceiptDeletion>>
  > = [];
  const generations =
    options.receiptsOnCommit?.generations ??
    (source
      ? receiptOnlyTargets.map((target) => ({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          lifecycleRevision: target.lifecycleRevision ?? null,
        }))
      : []);
  const generationsByAgent = new Map<string, Map<string, GitHubSessionReceiptGeneration>>();
  for (const generation of generations) {
    const grouped =
      generationsByAgent.get(generation.agentId) ??
      new Map<string, GitHubSessionReceiptGeneration>();
    const key = JSON.stringify([generation.sessionKey, generation.sessionId]);
    if (!grouped.has(key)) {
      grouped.set(key, generation);
    }
    generationsByAgent.set(generation.agentId, grouped);
  }
  for (const [agentId, grouped] of generationsByAgent) {
    receiptDeletions.push(
      await preparePersonalGitHubSessionReceiptDeletion({
        agentId,
        env,
        generations: [...grouped.values()],
        assertCurrent,
      }),
    );
  }
  let settled = false;
  return {
    settleReceipts: async (assertCommittedCurrent?: () => void) => {
      if (!options.receiptsOnCommit) {
        throw new Error("Receipt settlement requires a receiptsOnCommit declaration");
      }
      if (settled) {
        throw new Error("Session receipts already settled");
      }
      settled = true;
      for (const settle of receiptDeletions) {
        await settle({ assertCurrent: assertCommittedCurrent });
      }
    },
    async settlePresence() {
      if (!source || receiptOnlyTargets.length === 0) {
        return;
      }
      const assertSourceCurrent = () => {
        assertRepositoryCurrent();
        if ("memory" in source) {
          source.memory.assertCurrent();
        } else {
          const { database } = source;
          assertExistingDatabaseIdentity(database.canonicalPath, database.key, database.birthtime);
        }
      };
      const sessionKeys = receiptOnlyTargets.map((target) => target.sessionKey);
      const readPresentKeys = async (): Promise<Set<string>> => {
        if ("memory" in source) {
          return new Set(
            sessionKeys.filter(
              (sessionKey) =>
                source.memory.readSession(sessionKey, {
                  assertCurrent: assertSourceCurrent,
                  authorize() {},
                })?.entry,
            ),
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
      // Receipt selection is generation-precise; unlike workspaces, it needs no source binding
      // or transaction-held session absence admission after the post-run presence check.
      assertSourceCurrent();
      const present = await readPresentKeys();
      for (const settle of receiptDeletions) {
        await settle({
          assertCurrent: assertSourceCurrent,
          retainedSessionKeys: present,
        });
      }
    },
  };
}

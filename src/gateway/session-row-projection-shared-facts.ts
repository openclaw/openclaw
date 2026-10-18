import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { rowToAcpSessionMeta } from "../acp/runtime/session-meta-readonly.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  identity,
  type RetainedSessionRowDatabaseFacts,
  type Row,
} from "./session-row-projection-record.js";

export function prepareSessionRowSharedFacts({
  rows,
  facts,
  env,
  shared,
}: {
  rows: readonly Row[];
  facts: ReadonlyMap<string, RetainedSessionRowDatabaseFacts>;
  env: NodeJS.ProcessEnv;
  shared: ReturnType<typeof captureOpenClawStateReadWorkerContext>;
}) {
  const sharedRows = rows.flatMap((row) => {
    const prepared = facts.get(identity(row));
    if (!prepared) {
      return [];
    }
    if (!prepared.entry) {
      prepared.acpMeta = null;
    }
    if (!prepared.entry?.repositoryWorkspaceId) {
      prepared.repositoryWorkspace = null;
    }
    return prepared.acpMeta !== undefined && prepared.repositoryWorkspace !== undefined
      ? []
      : [{ row, prepared }];
  });
  if (!sharedRows.length) {
    return undefined;
  }
  return {
    assertCurrent: () => shared.admission.assertCurrent(),
    reply: executeExistingOpenClawStateRead(
      { env, path: resolveOpenClawStateSqlitePath(env) },
      {
        type: "sessionRows.sharedFacts",
        entries: sharedRows.map(({ row, prepared }) => ({
          ...(prepared.acpMeta === undefined
            ? {
                acp: {
                  keys: [
                    buildAcpDatabaseSessionKey(normalizeStoreSessionKey(row.key), row.agentId),
                  ],
                  entry: {
                    sessionId: prepared.entry?.sessionId,
                    lifecycleRevision: prepared.entry?.lifecycleRevision,
                    sessionStartedAt: prepared.entry?.sessionStartedAt,
                  },
                },
              }
            : {}),
          ...(prepared.repositoryWorkspace === undefined && prepared.entry?.repositoryWorkspaceId
            ? {
                repositoryWorkspace: {
                  agentId: row.agentId,
                  sessionKey: row.key,
                  workspaceId: prepared.entry.repositoryWorkspaceId,
                },
              }
            : {}),
        })),
      },
      { context: shared },
    ),
    accept(reply: Awaited<ReturnType<typeof executeExistingOpenClawStateRead>>) {
      if (reply && (!reply.ok || reply.type !== "sessionRows.sharedFacts")) {
        throw new Error("Unexpected session row shared-state facts");
      }
      for (const [index, { prepared }] of sharedRows.entries()) {
        const sharedFacts = reply?.rows[index];
        if (prepared.acpMeta === undefined) {
          prepared.acpMeta = sharedFacts?.acp ? rowToAcpSessionMeta(sharedFacts.acp) : null;
        }
        if (prepared.repositoryWorkspace === undefined) {
          prepared.repositoryWorkspace = sharedFacts?.repositoryWorkspace ?? null;
        }
      }
    },
  };
}

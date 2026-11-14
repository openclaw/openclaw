import { expect } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

export function journalInput(
  state: OpenClawTestState,
  agentId = "worker",
  operationId = `delete-${agentId}`,
) {
  return {
    agentId,
    operationId,
    agentDir: state.agentDir(agentId),
    workspaceDir: state.workspaceDir,
    sessionsDir: state.sessionsDir(agentId),
    deleteFiles: false,
  };
}

export function completeDeletion(
  state: OpenClawTestState,
  agentId: string,
  workspaceDir = state.workspaceDir,
) {
  const options = { env: state.env };
  const deletion = beginAgentDeletionJournal(
    { ...journalInput(state, agentId), workspaceDir },
    options,
  );
  runOpenClawStateWriteTransaction(
    (database) => completeAgentDeletionJournalInDatabase(database, agentId, deletion.operationId),
    options,
  );
}

export async function withoutHostSql<T>(run: () => Promise<T>): Promise<T> {
  const observation = observeHostDataSql();
  try {
    const result = await run();
    expect(observation.queries).toEqual([]);
    for (const call of observation.calls) {
      expect(call).not.toHaveBeenCalled();
    }
    return result;
  } finally {
    observation.restore();
  }
}

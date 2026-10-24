import { expect } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

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

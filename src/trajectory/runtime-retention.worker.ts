import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  prepareTrajectoryRuntimeRetention,
  type TrajectoryRuntimeRetentionInput,
} from "./runtime-retention.sqlite.js";

export const trajectoryRuntimeRetentionReadOperations = {
  "trajectoryRetention.read": (
    input: TrajectoryRuntimeRetentionInput & { agentId: string; now: number },
    context: SqliteReadOnlyOperationContext,
  ) => {
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const options = { ...context, agentId: input.agentId };
    try {
      const result = scope.run(options, () =>
        withOpenClawAgentDatabaseReadOnly(
          ({ db }) => prepareTrajectoryRuntimeRetention(db, input, input.now),
          options,
        ),
      );
      if (!result.found) {
        throw new Error("Trajectory retention database disappeared before reading");
      }
      return result.value;
    } finally {
      scope.close();
    }
  },
};

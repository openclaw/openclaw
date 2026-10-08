import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import { adoptPreparedCanonicalSessionValidationSchema } from "../state/openclaw-agent-canonical-validation-schema.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { TrajectoryRuntimeRetentionReadOperations } from "./runtime-retention.contract.js";
import { prepareTrajectoryRuntimeRetention } from "./runtime-retention.sqlite.js";

export const trajectoryRuntimeRetentionReadOperations = {
  "trajectoryRetention.read": (
    input: TrajectoryRuntimeRetentionReadOperations["trajectoryRetention.read"]["input"],
    context: SqliteReadOnlyOperationContext,
  ): TrajectoryRuntimeRetentionReadOperations["trajectoryRetention.read"]["output"] => {
    if (input.schemaContract) {
      adoptPreparedCanonicalSessionValidationSchema(input.schemaContract);
    }
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

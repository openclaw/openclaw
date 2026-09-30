import type {
  SubagentMaintenanceDurableBasis,
  SubagentRunsDurableBasis,
} from "../../agents/subagents/registry/subagent-registry-read.types.js";
import {
  subagentMaintenanceDurableBasisMatches,
  subagentRunsDurableBasisMatches,
} from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

/** Compare fresh durable facts after the host grants its live deletion authority. */
export function assertSessionSubagentRunsCurrent(
  params: {
    descendantRunBasis?: SubagentRunsDurableBasis;
    maintenanceRunBasis?: SubagentMaintenanceDurableBasis;
  },
  env: NodeJS.ProcessEnv,
): void {
  const bases = [params.descendantRunBasis, params.maintenanceRunBasis].filter(
    (basis) => basis !== undefined,
  );
  if (bases.length === 0) {
    return;
  }
  const pathname = resolveOpenClawStateSqlitePath(env);
  const assertSource = () => {
    const identity = readDatabasePathIdentitySync(pathname);
    if (
      bases.some(
        (basis) =>
          pathname !== basis.databasePath ||
          identity.key !== basis.databaseIdentity ||
          identity.birthtime !== basis.databaseBirthtime,
      )
    ) {
      throw new Error("Session subagent source changed before commit");
    }
  };
  assertSource();
  const matches = withExistingOpenClawStateDatabaseCurrentReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () =>
          (!params.descendantRunBasis ||
            subagentRunsDurableBasisMatches(database, params.descendantRunBasis)) &&
          (!params.maintenanceRunBasis ||
            subagentMaintenanceDurableBasisMatches(database, params.maintenanceRunBasis)),
        { databaseLabel: pathname, operationLabel: "session.subagent-commit-facts" },
      ),
    { path: pathname, env },
  );
  assertSource();
  if (
    matches !== true &&
    !(matches === undefined && bases.every((basis) => basis.digest === null))
  ) {
    throw new Error("Session subagent facts changed before commit");
  }
}

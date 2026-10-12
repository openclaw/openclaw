import type { SubagentRunsDurableBasis } from "../../agents/subagents/registry/subagent-registry-read.types.js";
import { subagentRunsDurableBasisMatches } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

/** Compare fresh durable facts after the host grants its live deletion authority. */
export function assertSessionSubagentRunsCurrent(
  params: {
    descendantRunBasis?: SubagentRunsDurableBasis;
  },
  env: NodeJS.ProcessEnv,
): void {
  const basis = params.descendantRunBasis;
  if (!basis) {
    return;
  }
  const pathname = resolveOpenClawStateSqlitePath(env);
  const assertSource = () => {
    const identity = readDatabasePathIdentitySync(pathname);
    if (
      pathname !== basis.databasePath ||
      identity.key !== basis.databaseIdentity ||
      identity.birthtime !== basis.databaseBirthtime
    ) {
      throw new Error("Session subagent source changed before commit");
    }
  };
  assertSource();
  const matches = withExistingOpenClawStateDatabaseCurrentReadOnly(
    (database) => subagentRunsDurableBasisMatches(database, basis),
    { path: pathname, env },
  );
  assertSource();
  if (matches !== true && !(matches === undefined && basis.digest === null)) {
    throw new Error("Session subagent facts changed before commit");
  }
}

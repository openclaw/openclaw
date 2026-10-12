import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import type {
  OpenClawAgentDatabaseReadOnlyResult,
  OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "./openclaw-agent-db-readonly-scope.js";

const companions = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseReadOnlyCompanions"),
  () => new WeakMap<DatabaseSync, OpenClawAgentDatabaseReadOnlyScope>(),
);

/** Keep committed reads separate from the writer using the ordinary reader lifecycle. */
export function withCommittedOpenClawAgentDatabaseReadOnly<T>(
  writer: OpenClawAgentDatabase,
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: { snapshot?: boolean } = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  let scope = companions.get(writer.db);
  if (!scope) {
    scope = new OpenClawAgentDatabaseReadOnlyScope(true);
    const owned = scope;
    registerNodeSqliteDisposeCallback(writer.db, () => owned.close());
    companions.set(writer.db, scope);
  }
  const owned = scope;
  return owned.run({ agentId: writer.agentId, path: writer.path }, () =>
    owned.read(operation, options, behavior),
  );
}

import { createDeferredCore } from "../../shared/deferred.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { isOpenClawAgentDatabasePathCurrent } from "../../state/openclaw-agent-db-identity.js";
import {
  agentDatabaseLifecycle,
  retainAgentDatabase,
} from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

/** Native-only scopes retain their original handle, not a pathname reopened after commit. */
export async function withNativeSessionCommitContext<T>(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
  commit: (source?: SessionEntryCommitContext) => T,
  afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>,
): Promise<T> {
  if (!afterCommitted) {
    return commit();
  }
  if (database.db.isTransaction) {
    throw new Error("Session commit follow-up requires an outer transaction");
  }
  const capturedEnv = Object.freeze({ ...env });
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(capturedEnv),
  );
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const completion = createDeferredCore();
  let active = true;
  const revoke = () => {
    active = false;
  };
  const context: SessionEntryCommitContext = {
    env: capturedEnv,
    assertCurrent() {
      if (
        !active ||
        agentDatabaseLifecycle.databases.get(database.path) !== database ||
        !isOpenClawAgentDatabasePathCurrent(database)
      ) {
        throw new Error("Session commit owner is no longer current");
      }
      if (agentDatabaseLifecycle.failures.has(database.path)) {
        throw agentDatabaseLifecycle.failures.get(database.path);
      }
      state.assertCurrent();
      maintenance?.assertAdmission();
      assertAgentDatabaseAdmitted(database.agentId, { env: capturedEnv });
    },
  };
  context.assertCurrent();
  const release = retainAgentDatabase(database.db);
  let unregisterAgent: (() => void) | undefined;
  let unregisterState: (() => void) | undefined;
  try {
    unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
      agentId: database.agentId,
      path: database.path,
      revoke,
      close: () => completion.promise,
    });
    unregisterState = registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (!identity || identity.key === state.identity.key) {
          revoke();
          await completion.promise;
        }
      },
    });
    const result = commit(context);
    await afterCommitted(context);
    return result;
  } finally {
    revoke();
    release();
    completion.resolve();
    unregisterAgent?.();
    unregisterState?.();
  }
}

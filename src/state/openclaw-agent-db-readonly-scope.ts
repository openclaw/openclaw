import { AsyncLocalStorage } from "node:async_hooks";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { isOpenClawAgentDatabasePathCurrent } from "./openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "./openclaw-agent-db-readonly-open.js";

export type OpenClawAgentDatabaseReadOnlyBehavior = {
  throwOnMissingTable?: boolean;
  allowExtension?: boolean;
};

const readOnlyScope = new AsyncLocalStorage<OpenClawAgentDatabaseReadOnlyScope>();

/** One retained connection; its caller owns explicit close or worker retirement. */
export class OpenClawAgentDatabaseReadOnlyScope {
  private database?: OpenClawAgentReadOnlyDatabaseHandle;
  private target?: { agentId: string; path: string };

  get hasRetainedConnection(): boolean {
    return this.database !== undefined;
  }

  close(): void {
    const database = this.database;
    // Descendant async contexts retain this object after run returns. Revoke reuse first.
    this.target = undefined;
    this.database = undefined;
    database?.close();
  }

  run<T>(target: { agentId: string; path: string }, operation: () => T): T {
    if (this.target?.agentId !== target.agentId || this.target.path !== target.path) {
      this.database?.close();
      this.database = undefined;
    }
    this.target = target;
    return readOnlyScope.run(this, operation);
  }

  matches(agentId: string, pathname: string): boolean {
    return this.target?.agentId === agentId && this.target.path === pathname;
  }

  read<T>(
    operation: (database: OpenClawAgentReadOnlyDatabase) => T,
    options: OpenClawAgentDatabaseOptions,
    behavior: OpenClawAgentDatabaseReadOnlyBehavior,
  ): OpenClawAgentDatabaseReadOnlyResult<T> {
    if (this.database?.db.isTransaction) {
      return withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
    }
    if (this.database && !isOpenClawAgentDatabasePathCurrent(this.database)) {
      this.database.close();
      this.database = undefined;
    }
    if (!this.database) {
      const opened = openOpenClawAgentDatabaseReadOnly(options);
      if (!opened.found) {
        return opened;
      }
      this.database = opened.database;
      enableNodeSqliteKyselyStatementCache(this.database.db);
    } else if (!hasOpenClawAgentReadOnlySchema(this.database)) {
      this.database.close();
      this.database = undefined;
      return { found: false, reason: "schema-missing" };
    }
    return readOpenClawAgentDatabaseReadOnly(this.database, operation, behavior);
  }
}

/** Reuse only the caller's matching read scope; other reads own an independent handle. */
export function withScopedOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions & { agentId: string; path: string },
  behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  const scope = behavior.allowExtension ? undefined : readOnlyScope.getStore();
  return scope?.matches(options.agentId, options.path)
    ? scope.read(operation, options, behavior)
    : withFreshOpenClawAgentDatabaseReadOnly(operation, options, behavior);
}

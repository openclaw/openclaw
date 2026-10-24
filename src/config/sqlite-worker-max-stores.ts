import { listAgentEntries } from "../agents/agent-roster.js";
import {
  SQLITE_WORKER_DEFAULT_MAX_STORES,
  setSqliteWorkerMaxStores,
} from "../infra/sqlite-worker-broker-limits.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Size the process-global SQLite store budget for the configured agent roster. */
export function resolveSqliteWorkerMaxStores(config?: OpenClawConfig): number {
  const configuredMaxStores = config?.database?.sqlite?.maxStores;
  if (configuredMaxStores !== undefined) {
    return configuredMaxStores;
  }
  const configuredAgentCount = config ? listAgentEntries(config).length : 0;
  return Math.max(SQLITE_WORKER_DEFAULT_MAX_STORES, configuredAgentCount * 2);
}

/** Publish the resolved budget so the shared broker honors the active configuration. */
export function publishSqliteWorkerMaxStores(config?: OpenClawConfig): void {
  setSqliteWorkerMaxStores(resolveSqliteWorkerMaxStores(config));
}

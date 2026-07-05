// Memory status collection for status scans.
// Runtime memory dependencies stay lazy so status paths without memory avoid loading the search manager.

<<<<<<< HEAD
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
=======
import os from "node:os";
import path from "node:path";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import {
  resolveSharedMemoryStatusSnapshot,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";

const statusScanDepsRuntimeModuleLoader = createLazyImportLoader(
  () => import("./status.scan.deps.runtime.js"),
);

function loadStatusScanDepsRuntimeModule() {
  return statusScanDepsRuntimeModuleLoader.load();
}

<<<<<<< HEAD
/** Returns the owning agent database path for built-in memory. */
export function resolveDefaultMemoryDatabasePath(agentId: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId });
=======
/** Returns the default on-disk memory store path for an agent. */
export function resolveDefaultMemoryStorePath(agentId: string): string {
  return path.join(resolveStateDir(process.env, os.homedir), "memory", `${agentId}.sqlite`);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

/** Resolves memory index/cache status for the current status scan. */
export async function resolveStatusMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  memoryPlugin: MemoryPluginStatus;
<<<<<<< HEAD
  requireDefaultDatabasePath?: (agentId: string) => string;
=======
  requireDefaultStore?: (agentId: string) => string;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}): Promise<MemoryStatusSnapshot | null> {
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  return await resolveSharedMemoryStatusSnapshot({
    cfg: params.cfg,
    agentStatus: params.agentStatus,
    memoryPlugin: params.memoryPlugin,
    resolveMemoryConfig: resolveMemorySearchConfig,
    getMemorySearchManager,
<<<<<<< HEAD
    requireDefaultDatabasePath: params.requireDefaultDatabasePath,
=======
    requireDefaultStore: params.requireDefaultStore,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
}

import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
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

export function resolveDefaultMemoryDatabasePath(agentId: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId });
}

export async function resolveStatusMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  memoryPlugin: MemoryPluginStatus;
  requireDefaultDatabasePath?: (agentId: string) => string;
}): Promise<MemoryStatusSnapshot | null> {
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  return await resolveSharedMemoryStatusSnapshot({
    cfg: params.cfg,
    agentStatus: params.agentStatus,
    memoryPlugin: params.memoryPlugin,
    resolveMemoryConfig: resolveMemorySearchConfig,
    getMemorySearchManager,
    requireDefaultDatabasePath: params.requireDefaultDatabasePath,
  });
}

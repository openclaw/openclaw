import os from "node:os";
import path from "node:path";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSharedMemoryStatusSnapshot, } from "./status.scan.shared.js";
let statusScanDepsRuntimeModulePromise;
function loadStatusScanDepsRuntimeModule() {
    statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
    return statusScanDepsRuntimeModulePromise;
}
export function resolveDefaultMemoryStorePath(agentId) {
    return path.join(resolveStateDir(process.env, os.homedir), "memory", `${agentId}.sqlite`);
}
export async function resolveStatusMemoryStatusSnapshot(params) {
    const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
    return await resolveSharedMemoryStatusSnapshot({
        cfg: params.cfg,
        agentStatus: params.agentStatus,
        memoryPlugin: params.memoryPlugin,
        resolveMemoryConfig: resolveMemorySearchConfig,
        getMemorySearchManager,
        requireDefaultStore: params.requireDefaultStore,
    });
}

import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

export async function getRequiredMemoryIndexManager(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<MemoryIndexManager> {
  const result = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId ?? "main",
  });
  if (!result.manager) {
    throw new Error("manager missing");
  }
  if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
    throw new Error("manager does not support sync");
  }
  return result.manager as unknown as MemoryIndexManager;
}

import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager } from "../plugin-sdk/memory-core.js";
import type { MemoryIndexManager } from "../plugin-sdk/memory-core.js";

export async function createMemoryManagerOrThrow(
  cfg: OpenClawConfig,
  agentId = "main",
): Promise<MemoryIndexManager> {
  const result = await getMemorySearchManager({ cfg, agentId });
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager as unknown as MemoryIndexManager;
}

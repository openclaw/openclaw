import {
  getMemorySearchManager,
  type MemoryIndexManager,
} from "../../extensions/memory-core/src/memory/index.js";
import type { OpenClawConfig } from "../config/config.js";

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

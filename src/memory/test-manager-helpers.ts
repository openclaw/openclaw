import type { MemoryIndexManager } from "../../extensions/memory-core/src/memory/index.js";
import type { OpenClawConfig } from "../config/config.js";

export async function getRequiredMemoryIndexManager(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager> {
  await import("./embedding.test-mocks.js");
  const { getMemorySearchManager } =
    await import("../../extensions/memory-core/src/memory/index.js");
  const result = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId ?? "main",
    purpose: params.purpose,
  });
  if (!result.manager) {
    throw new Error("manager missing");
  }
  if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
    throw new Error("manager does not support sync");
  }
  return result.manager as unknown as MemoryIndexManager;
}

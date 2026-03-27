import type { OpenClawConfig } from "../config/config.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import type { MemoryProviderStatus } from "../plugins/memory-host/types.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";

export { getTailnetHostname };

type StatusMemoryManager = {
  probeVectorAvailability(): Promise<boolean>;
  status(): MemoryProviderStatus;
  close?(): Promise<void>;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: "status";
}): Promise<{ manager: StatusMemoryManager | null }> {
  const { manager } = await getActiveMemorySearchManager(params);
  if (!manager) {
    return { manager: null };
  }
  return {
    manager: {
      async probeVectorAvailability() {
        return await manager.probeVectorAvailability();
      },
      status() {
        return manager.status();
      },
      close: manager.close ? async () => await manager.close?.() : undefined,
    },
  };
}

import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;

export async function waitForAcpRuntimeBackendReady(backendId?: string): Promise<boolean> {
  const { getAcpRuntimeBackend } = await import("../acp/runtime/registry.js");
  const deadline = performance.now() + ACP_BACKEND_READY_TIMEOUT_MS;

  do {
    const backend = getAcpRuntimeBackend(backendId);
    if (backend) {
      try {
        if (!backend.healthy || backend.healthy()) {
          return true;
        }
      } catch {
        // Treat transient backend health probe errors like "not ready yet".
      }
    }
    await sleep(ACP_BACKEND_READY_POLL_MS, undefined, { ref: false });
  } while (performance.now() < deadline);

  return false;
}

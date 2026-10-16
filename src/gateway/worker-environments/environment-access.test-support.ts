import { vi } from "vitest";
import type { WorkerTunnelManager } from "./tunnel.js";

export function createStoppedTunnelManager(desktop: Partial<WorkerTunnelManager["desktop"]> = {}) {
  const unsupported = () => {
    throw new Error("Unexpected operation on stopped tunnel fixture");
  };
  return {
    desktop: {
      acquire: vi.fn(unsupported),
      attachObserver: vi.fn(unsupported),
      launchApp: vi.fn(unsupported),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
      ...desktop,
    },
    status: () => "stopped" as const,
    start: vi.fn(unsupported),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
  } satisfies WorkerTunnelManager;
}

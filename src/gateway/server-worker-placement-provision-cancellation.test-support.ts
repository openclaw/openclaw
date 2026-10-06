import { vi } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import type { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type * as support from "./worker-environments/service.test-support.js";

export function createRuntime(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
  environments: ReturnType<typeof support.createService>,
) {
  return createGatewayWorkerPlacementRuntime({
    scheduler: createTestGatewayScheduler(),
    getCommittedRuntimeConfig: getRuntimeConfig,
    placements,
    environments,
    gatewayNamespace: "gateway-test",
    warn: vi.fn(),
    cancelSessionWork: vi.fn(async () => {}),
    revokeSessionAuthority: vi.fn(),
  });
}

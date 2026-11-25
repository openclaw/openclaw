import { vi } from "vitest";
import type { GatewayLifecycleRuntime } from "./server-instance-runtime.types.js";

export function createMockGatewayLifecycleRuntime(
  overrides: Partial<GatewayLifecycleRuntime> = {},
): GatewayLifecycleRuntime {
  return {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendNotice: vi.fn(),
    ...overrides,
  };
}

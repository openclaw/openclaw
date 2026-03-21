import type { RuntimeEnv } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export function createRuntimeEnv(options?: { throwOnExit?: boolean }): RuntimeEnv {
  const throwOnExit = options?.throwOnExit ?? true;
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: throwOnExit
      ? vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        })
      : vi.fn(),
  };
}

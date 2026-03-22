import type { RuntimeEnv } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export function createRuntimeEnv<TRuntime = RuntimeEnv>(options?: {
  throwOnExit?: boolean;
}): RuntimeEnv {
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

export function createTypedRuntimeEnv<TRuntime>(options?: { throwOnExit?: boolean }): TRuntime {
  return createRuntimeEnv(options) as TRuntime;
}

export function createNonExitingRuntimeEnv(): RuntimeEnv {
  return createRuntimeEnv({ throwOnExit: false });
}

export function createNonExitingTypedRuntimeEnv<TRuntime>(): TRuntime {
  return createTypedRuntimeEnv<TRuntime>({ throwOnExit: false });
}

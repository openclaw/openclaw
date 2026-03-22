import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export function createRuntimeEnv<TRuntime = OutputRuntimeEnv>(options?: {
  throwOnExit?: boolean;
}): OutputRuntimeEnv {
  const throwOnExit = options?.throwOnExit ?? true;
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
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

export function createNonExitingRuntimeEnv(): OutputRuntimeEnv {
  return createRuntimeEnv({ throwOnExit: false });
}

export function createNonExitingTypedRuntimeEnv<TRuntime>(): TRuntime {
  return createTypedRuntimeEnv<TRuntime>({ throwOnExit: false });
}

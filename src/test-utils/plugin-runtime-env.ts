import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { vi } from "vitest";

type RuntimeEnvOptions = {
  throwOnExit?: boolean;
};

type TypedRuntimeEnvOptions<TRuntime extends OutputRuntimeEnv> = RuntimeEnvOptions & {
  readonly __runtimeShape?: (runtime: TRuntime) => void;
};

export function createRuntimeEnv(options?: RuntimeEnvOptions): OutputRuntimeEnv {
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

export function createTypedRuntimeEnv<TRuntime extends OutputRuntimeEnv>(
  options?: TypedRuntimeEnvOptions<TRuntime>,
): TRuntime {
  return createRuntimeEnv(options) as TRuntime;
}

export function createNonExitingRuntimeEnv(): OutputRuntimeEnv {
  return createRuntimeEnv({ throwOnExit: false });
}

export function createNonExitingTypedRuntimeEnv<TRuntime extends OutputRuntimeEnv>(
  runtimeShape?: (runtime: TRuntime) => void,
): TRuntime {
  return createTypedRuntimeEnv<TRuntime>({ throwOnExit: false, __runtimeShape: runtimeShape });
}

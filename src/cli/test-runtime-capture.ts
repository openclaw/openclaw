// Shared Vitest runtime capture helpers for CLI command output assertions.
import { vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { createCliRuntimeMock } from "./test-runtime-mock.js";

export type CliMockOutputRuntime = OutputRuntimeEnv & {
  log: MockFn<OutputRuntimeEnv["log"]>;
  error: MockFn<OutputRuntimeEnv["error"]>;
  exit: MockFn<OutputRuntimeEnv["exit"]>;
  writeJson: MockFn<OutputRuntimeEnv["writeJson"]>;
  writeStdout: MockFn<OutputRuntimeEnv["writeStdout"]>;
};

export type CliRuntimeCapture = {
  runtimeLogs: string[];
  runtimeErrors: string[];
  defaultRuntime: CliMockOutputRuntime;
  resetRuntimeCapture: () => void;
};

type MockCallsWithFirstArg = {
  mock: {
    calls: Array<[unknown, ...unknown[]]>;
  };
};

type MockCalls = {
  mock: {
    calls: unknown[][];
  };
};

export function createCliRuntimeCapture(): CliRuntimeCapture {
  const { runtimeLogs, runtimeErrors, defaultRuntime } = createCliRuntimeMock(vi);
  return {
    runtimeLogs,
    runtimeErrors,
    defaultRuntime,
    resetRuntimeCapture: () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
    },
  };
}

export async function mockRuntimeModule<TModule extends { defaultRuntime: OutputRuntimeEnv }>(
  loadActual: () => Promise<TModule>,
  defaultRuntime: TModule["defaultRuntime"],
): Promise<TModule> {
  const actual = await loadActual();
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      ...defaultRuntime,
    },
  };
}

export function spyRuntimeLogs(runtime: Pick<OutputRuntimeEnv, "log">) {
  return vi.spyOn(runtime, "log").mockImplementation(() => {});
}

export function spyRuntimeErrors(runtime: Pick<OutputRuntimeEnv, "error">) {
  return vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function spyRuntimeJson(runtime: Pick<OutputRuntimeEnv, "writeJson">) {
  return vi.spyOn(runtime, "writeJson").mockImplementation(() => {});
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets callers ascribe captured JSON shape.
export function firstWrittenJsonArg<T>(writeJson: MockCallsWithFirstArg): T | null {
  return (writeJson.mock.calls.at(0)?.[0] ?? null) as T | null;
}

export function getMockCallOutput(mockFn: MockCalls): string {
  return mockFn.mock.calls.map((call) => String(call[0])).join("\n");
}

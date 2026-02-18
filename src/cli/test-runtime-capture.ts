import type { RuntimeEnv } from "../runtime.js";

export type CliRuntimeCapture = {
  runtimeLogs: string[];
  runtimeErrors: string[];
  defaultRuntime: Pick<RuntimeEnv, "log" | "error" | "exit">;
  resetRuntimeCapture: () => void;
};

export function createCliRuntimeCapture(): CliRuntimeCapture {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  return {
    runtimeLogs,
    runtimeErrors,
    defaultRuntime: {
      log: (msg: string) => runtimeLogs.push(msg),
      error: (msg: string) => runtimeErrors.push(msg),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    },
    resetRuntimeCapture: () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
    },
  };
}

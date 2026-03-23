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
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  return {
    runtimeLogs,
    runtimeErrors,
    defaultRuntime: {
      log: (...args: unknown[]) => {
        runtimeLogs.push(stringifyArgs(args));
      },
      error: (...args: unknown[]) => {
        runtimeErrors.push(stringifyArgs(args));
      },
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

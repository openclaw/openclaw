import type { OutputRuntimeEnv } from "../runtime.js";

export type CliRuntimeCapture = {
  runtimeLogs: string[];
  runtimeErrors: string[];
  defaultRuntime: Pick<OutputRuntimeEnv, "log" | "error" | "exit" | "writeStdout" | "writeJson">;
  resetRuntimeCapture: () => void;
};

export function createCliRuntimeCapture(): CliRuntimeCapture {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const writeLine = (value: string) => {
    runtimeLogs.push(value.endsWith("\n") ? value.slice(0, -1) : value);
  };
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
      writeStdout: (value: string) => {
        writeLine(value);
      },
      writeJson: (value: unknown, space = 2) => {
        writeLine(JSON.stringify(value, null, space > 0 ? space : undefined));
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

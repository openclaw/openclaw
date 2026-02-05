import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";

export type RuntimeEnv = {
  log: typeof console.log;
  error: typeof console.error;
  exit: (code: number) => never;
};

export const defaultRuntime: RuntimeEnv = {
  log: (...args: Parameters<typeof console.log>) => {
    clearActiveProgressLine();
    console.log(...args);
  },
  error: (...args: Parameters<typeof console.error>) => {
    clearActiveProgressLine();
    console.error(...args);
  },
  exit: (code) => {
    restoreTerminalState("runtime exit");
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};
